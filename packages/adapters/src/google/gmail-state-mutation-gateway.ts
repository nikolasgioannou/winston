import { createHash, randomUUID } from "node:crypto";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CliResult } from "@winston/contracts/cli";
import {
  gmailTrashInputSchema,
  gmailTrashPlanSchema,
  type GmailTrashInput,
} from "@winston/contracts/gmail-trash";
import type { OwnerTransaction } from "../database";
import {
  gmailLabelMutationInputSchema,
  gmailLabelMutationPlanSchema,
  gmailLabelMessageSnapshotSchema,
  gmailLabelInventorySnapshotSchema,
  type GmailLabelMutationInput,
} from "@winston/contracts/gmail-label-mutations";
import type { GoogleReadOptions } from "./read-request";
import { createConnectedReadGateway } from "./cli-reads";
import { createConnectionTargets } from "./targets";
import { sameResolvedTarget } from "./target-resolution";
import { prepareGmailLabelMutation } from "./gmail-label-mutation-plan";
import { createGmailLabelMutationExecutor } from "./gmail-label-mutation-executor";
import { prepareGmailTrash } from "./gmail-trash-plan";
import { createGmailTrashExecutor } from "./gmail-trash-executor";
import { GmailMutationBlockedError } from "../database/gmail-mutation-blocking";

export type GmailStateGatewayOptions = Pick<GoogleReadOptions, "database" | "google" | "fetch">;
function result(
  status: Exclude<CliResult["status"], "ok">,
  message: string,
  referenceId?: string,
): CliResult {
  return { version: 1, status, message, ...(referenceId ? { referenceId } : {}) };
}

export function createGmailStateMutationGateway(
  options: GmailStateGatewayOptions,
  mode: "labels" | "trash",
) {
  const { database } = options;
  const targets = createConnectionTargets(database, options.google);
  const read = createConnectedReadGateway(options);
  const execute =
    mode === "labels"
      ? createGmailLabelMutationExecutor(options)
      : createGmailTrashExecutor(options);
  const repository = (scope: OwnerTransaction) =>
    mode === "labels" ? scope.gmailLabelActions : scope.gmailTrashActions;
  return async (
    credential: ServiceRequest,
    input: GmailLabelMutationInput | GmailTrashInput,
    inputSignal: AbortSignal,
  ): Promise<CliResult> => {
    const signal = AbortSignal.any([inputSignal, AbortSignal.timeout(45_000)]);
    const parsed =
      mode === "labels"
        ? gmailLabelMutationInputSchema.safeParse(input)
        : gmailTrashInputSchema.safeParse(input);
    if (!parsed.success)
      return result(
        "invalid_input",
        "Provide one message, an exact state change and a stable key.",
      );
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
      let action = await database.transaction(ownerId, (scope) =>
        repository(scope).find(worker, key, intent),
      );
      if (!action) {
        const selected = await targets.resolve(
          ownerId,
          {
            operation: mode === "labels" ? "gmail.modify" : "gmail.trash",
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
        const target = selected.target;
        const inspectionKey = createHash("sha256").update(key).digest("hex");
        const inspected = await read(
          credential,
          {
            version: 1,
            command: "gmail.message",
            accountId: intent.accountId,
            id: intent.messageId,
            key: `gmail-${mode === "labels" ? "label" : "trash"}-message:${inspectionKey}`,
          },
          signal,
        );
        if (inspected.status !== "ok") return inspected;
        const message = gmailLabelMessageSnapshotSchema.parse(inspected.data);
        // Cached approved reads survive a worker lease change, not an account or intent change.
        const rebase = (value: { source: typeof message.source }) => {
          if (
            value.source.task?.id !== worker.id ||
            !sameResolvedTarget(
              { ...value.source, operation: target.operation, task: target.task },
              target,
            )
          )
            throw new Error("Gmail inspection provenance changed.");
          value.source = { ...value.source, task: target.task };
        };
        rebase(message);
        let plan;
        if ("kind" in intent) {
          plan = prepareGmailTrash(
            randomUUID(),
            gmailTrashPlanSchema.shape.target.parse(target),
            intent,
            message,
          );
        } else {
          const listed = await read(
            credential,
            {
              version: 1,
              command: "gmail.labels",
              accountId: intent.accountId,
              key: `gmail-label-inventory:${inspectionKey}`,
            },
            signal,
          );
          if (listed.status !== "ok") return listed;
          const inventory = gmailLabelInventorySnapshotSchema.parse(listed.data);
          rebase(inventory);
          plan = prepareGmailLabelMutation(
            randomUUID(),
            gmailLabelMutationPlanSchema.shape.target.parse(target),
            intent,
            message,
            inventory,
          );
        }
        signal.throwIfAborted();
        action = await database.transaction(ownerId, async (scope) => {
          if (!(await scope.capabilities.authenticate(credential)))
            throw new Error("Task authority expired.");
          return repository(scope).prepare(worker, key, intent, plan);
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
            !(await repository(scope).referencesCurrent(pending.request.arguments))
          )
            return false;
          await scope.tasks.finishStep(worker.id, worker.revision, worker.generation, {
            state: "waiting",
            blocker: {
              kind: "approval",
              referenceId: pending.id,
              detail: "Review the exact Gmail message change.",
            },
          });
          return true;
        });
        return waiting
          ? result(
              "waiting",
              "Waiting for approval of this exact Gmail change. Resume with the same key and arguments.",
              action.id,
            )
          : result("denied", "This Gmail approval expired or its account changed.", action.id);
      }
      if (action.state === "approved") {
        const completed = await execute(ownerId, action.id, action.hash, worker, signal);
        if (!completed)
          return result("denied", "This Gmail change no longer has current authority.", action.id);
        action = completed;
      }
      if (action.state === "succeeded")
        return {
          version: 1,
          status: "ok",
          data: { actionId: action.id, messageId: intent.messageId, outcome: action.outcome },
        };
      if (["denied", "invalidated"].includes(action.state))
        return result("denied", "This Gmail change is not authorized.", action.id);
      if (action.state === "failed")
        return result(
          "unavailable",
          action.outcome?.detail ?? "The Gmail change was not completed.",
          action.id,
        );
      return result(
        "unknown",
        "A Gmail write is in flight or has no confirmed result. Reconcile before another write.",
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
        "The Gmail change could not be prepared. Check the account, message state and selected operation.",
      );
    }
  };
}
