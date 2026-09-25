import { createHash, randomUUID } from "node:crypto";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CliResult } from "@winston/contracts/cli";
import {
  gmailMutationInputSchema,
  type GmailMutationInput,
  type GmailDraftVersion,
  type GmailReplySource,
} from "@winston/contracts/gmail-mutations";
import { gmailDraftInspectionSchema } from "@winston/contracts/gmail-mutation-sources";
import { gmailMutationReceiptSchema } from "@winston/contracts/gmail-mutation-responses";
import { gmailMessagePreparationSchema } from "@winston/contracts/gmail-messages";
import type { createArtifactReader } from "../artifacts";
import type { GoogleReadOptions } from "./read-request";
import { createConnectedReadGateway } from "./cli-reads";
import { createConnectionTargets } from "./targets";
import { sameResolvedTarget } from "./target-resolution";
import { prepareGmailMutation } from "./gmail-mutation-plan";
import { createGmailMutationExecutor } from "./gmail-mutation-executor";
import { readGmailOutgoingAttachments } from "./gmail-outgoing-attachments";
import { readGmailReplySource } from "./gmail-reply-source";
import { GmailMutationBlockedError } from "../database/gmail-mutation-blocking";

type Options = Pick<GoogleReadOptions, "database" | "google" | "fetch"> & {
  artifacts: ReturnType<typeof createArtifactReader>;
};
function result(
  status: Exclude<CliResult["status"], "ok">,
  message: string,
  referenceId?: string,
): CliResult {
  return { version: 1, status, message, ...(referenceId ? { referenceId } : {}) };
}
export function createGmailMutationGateway(options: Options) {
  const { database } = options;
  const targets = createConnectionTargets(database, options.google);
  const read = createConnectedReadGateway(options);
  const execute = createGmailMutationExecutor({ ...options, read: options.artifacts });
  return async (
    credential: ServiceRequest,
    input: GmailMutationInput,
    inputSignal: AbortSignal,
  ): Promise<CliResult> => {
    const signal = AbortSignal.any([inputSignal, AbortSignal.timeout(45_000)]);
    const parsed = gmailMutationInputSchema.safeParse(input);
    if (!parsed.success)
      return result("invalid_input", "Provide an exact Gmail message and stable request key.");
    const { key, intent } = parsed.data;
    const authority = await database.authenticateService(credential);
    if (authority?.operation !== "gateway:control")
      return result("denied", "Task control authority is unavailable or expired.");
    const ownerId = authority.ownerId;
    const worker = {
      id: authority.taskId,
      revision: authority.revision,
      generation: authority.generation,
    };
    const live = async () => {
      const current = await database.authenticateService(credential);
      return (
        current?.ownerId === ownerId &&
        current.taskId === worker.id &&
        current.revision === worker.revision &&
        current.generation === worker.generation
      );
    };
    try {
      signal.throwIfAborted();
      let action = await database.transaction(ownerId, ({ gmailActions }) =>
        gmailActions.find(worker, key, intent),
      );
      if (!action) {
        const selected = await targets.resolve(
          ownerId,
          {
            operation: intent.kind.endsWith("send") ? "gmail.send" : "gmail.draft",
            explicit: { connectionId: intent.accountId, calendarId: null },
            task: { id: worker.id, revision: worker.revision },
          },
          signal,
        );
        if (selected.status !== "resolved")
          return result(
            "unavailable",
            "The selected Gmail account is unavailable. Use accounts connect for Gmail to request a connection link.",
          );
        const target = gmailMessagePreparationSchema.shape.target.parse(selected.target);
        const source = (input: GmailDraftVersion["source"]) => {
          if (
            input.task?.id !== worker.id ||
            !sameResolvedTarget(
              { ...input, operation: target.operation, task: target.task },
              target,
            )
          )
            throw new Error("Gmail inspection provenance changed.");
          return { ...input, task: target.task };
        };
        let draft: GmailDraftVersion | undefined;
        if ("draftId" in intent) {
          const inspection = await read(
            credential,
            {
              version: 1,
              command: "gmail.draft",
              accountId: intent.accountId,
              id: intent.draftId,
              key: `gmail-draft:${createHash("sha256").update(key).digest("hex")}`,
            },
            signal,
          );
          if (inspection.status !== "ok") return inspection;
          const value = gmailDraftInspectionSchema.parse(inspection.data);
          draft = { source: source(value.source), id: value.id, messageId: value.message.id };
        }
        let replySource: GmailReplySource | undefined;
        if (intent.message.reply) {
          const inspection = await read(
            credential,
            {
              version: 1,
              command: "gmail.message",
              accountId: intent.accountId,
              id: intent.message.reply.sourceMessageId,
              key: `gmail-reply:${createHash("sha256").update(key).digest("hex")}`,
            },
            signal,
          );
          if (inspection.status !== "ok") return inspection;
          const value = await readGmailReplySource(inspection.data);
          replySource = { ...value, source: source(value.source) };
        }
        const contents = await readGmailOutgoingAttachments(
          options.artifacts,
          ownerId,
          intent.message.attachments,
          signal,
        );
        const prepared = await prepareGmailMutation(
          {
            operationId: randomUUID(),
            preparedAt: new Date().toISOString(),
            target,
            intent,
            ...(draft ? { draft } : {}),
            ...(replySource ? { replySource } : {}),
          },
          contents,
        );
        signal.throwIfAborted();
        action = await database.transaction(ownerId, async (scope) => {
          if (!(await scope.capabilities.authenticate(credential)))
            throw new Error("Task authority expired.");
          return scope.gmailActions.prepare(worker, key, intent, prepared.plan);
        });
      }
      if (!(await live()))
        return result("denied", "Task control authority is unavailable or expired.");
      if (action.state === "dispatching") {
        const id = action.id;
        const recovered = await database.transaction(ownerId, ({ actions }) => actions.recover(id));
        if (recovered) action = recovered;
      }
      if (action.state === "pending") {
        const pending = action;
        const waiting = await database.transaction(ownerId, async (scope) => {
          if (!(await scope.capabilities.authenticate(credential))) return false;
          const current = await scope.actions.expirePending(pending.id);
          const policy = await scope.authorization.evaluate(
            pending.request.authorization,
            pending.snapshot ?? undefined,
          );
          if (
            current?.state !== "pending" ||
            policy.decision === "deny" ||
            !(await scope.gmailActions.referencesCurrent(pending.request.arguments))
          )
            return false;
          await scope.tasks.finishStep(worker.id, worker.revision, worker.generation, {
            state: "waiting",
            blocker: {
              kind: "approval",
              referenceId: pending.id,
              detail: "Review the exact Gmail message.",
            },
          });
          return true;
        });
        return waiting
          ? result(
              "waiting",
              "Waiting for approval of this exact Gmail message. Resume with the same key and arguments.",
              action.id,
            )
          : result(
              "denied",
              "This Gmail approval expired or its account or attachments changed.",
              action.id,
            );
      }
      if (action.state === "approved") {
        const completed = await execute(ownerId, action.id, action.hash, worker, signal);
        if (!completed)
          return result(
            "denied",
            "This Gmail operation no longer has current authority.",
            action.id,
          );
        action = completed;
      }
      if (action.state === "succeeded") {
        const receipt = gmailMutationReceiptSchema.parse(
          JSON.parse(action.outcome?.providerReference ?? "null"),
        );
        return {
          version: 1,
          status: "ok",
          data: { actionId: action.id, receipt, outcome: action.outcome },
        };
      }
      if (["denied", "invalidated"].includes(action.state))
        return result("denied", "This Gmail operation is not authorized.", action.id);
      if (action.state === "failed")
        return result(
          "unavailable",
          action.outcome?.detail ?? "The Gmail operation was not completed.",
          action.id,
        );
      return result(
        "unknown",
        "A Gmail write is in flight or has no confirmed result. Inspect its operation; do not retry with a new key.",
        action.id,
      );
    } catch (error) {
      if (error instanceof GmailMutationBlockedError)
        return result(
          "unknown",
          "An earlier Gmail write remains unresolved. Reconcile it before another write.",
          error.actionId,
        );
      if (!(await live()))
        return result("denied", "Task control authority is unavailable or expired.");
      return result(
        "unavailable",
        "The Gmail operation could not be prepared safely. Check the draft version, reply source, account and attachments.",
      );
    }
  };
}
