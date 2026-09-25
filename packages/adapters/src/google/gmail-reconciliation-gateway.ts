import { createHash } from "node:crypto";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CliResult } from "@winston/contracts/cli";
import {
  cliGmailReconciliationRequestSchema,
  type CliGmailReconciliationRequest,
} from "@winston/contracts/cli";
import { gmailReconciliationEvidenceSchema } from "@winston/contracts/gmail-reconciliation";
import { readGmailMutationPlan } from "./gmail-mutation-plan";
import { readGmailLabelMutationPlan } from "./gmail-label-mutation-plan";
import { readGmailTrashPlan } from "./gmail-trash-plan";
import {
  readGmailMutationEvidence,
  type GmailReconciliationOptions,
} from "./gmail-reconciliation-read";

const uncertain = (id: string): CliResult => ({
  version: 1,
  status: "unknown",
  referenceId: id,
  message:
    "The Gmail result remains unresolved. No write was resent. Use a new observation key only for a deliberate later read.",
});
export function createGmailReconciliationGateway(options: GmailReconciliationOptions) {
  const { database } = options;
  return async (
    credential: ServiceRequest,
    input: CliGmailReconciliationRequest,
    inputSignal: AbortSignal,
  ): Promise<CliResult> => {
    const parsed = cliGmailReconciliationRequestSchema.safeParse(input);
    if (!parsed.success)
      return {
        version: 1,
        status: "invalid_input",
        message: "Provide an operation ID and observation key.",
      };
    const request = parsed.data;
    const authority = await database.authenticateService(credential);
    if (authority?.operation !== "gateway:control")
      return { version: 1, status: "denied", message: "Task control authority is unavailable." };
    const ownerId = authority.ownerId;
    const signal = AbortSignal.any([inputSignal, AbortSignal.timeout(45_000)]);
    try {
      const action = await database.transaction(ownerId, async ({ actions }) => {
        const found = await actions.find(request.id);
        if (
          !found ||
          !["gmail.draft", "gmail.send", "gmail.modify", "gmail.trash"].includes(
            found.request.authorization.operation,
          )
        )
          return null;
        return actions.recover(found.id);
      });
      if (!action) return { version: 1, status: "denied", message: "Gmail operation unavailable." };
      if (action.state === "succeeded")
        return {
          version: 1,
          status: "ok",
          data: { actionId: action.id, state: action.state, outcome: action.outcome },
        };
      if (["denied", "invalidated", "failed"].includes(action.state))
        return {
          version: 1,
          status: action.state === "failed" ? "unavailable" : "denied",
          referenceId: action.id,
          message: action.outcome?.detail ?? "This Gmail operation did not succeed.",
        };
      if (action.state !== "unknown") return uncertain(action.id);
      const plan =
        action.request.authorization.operation === "gmail.modify"
          ? readGmailLabelMutationPlan(action.request.arguments)
          : action.request.authorization.operation === "gmail.trash"
            ? readGmailTrashPlan(action.request.arguments)
            : readGmailMutationPlan(action.request.arguments);
      const target = "prepared" in plan ? plan.prepared.target : plan.target;
      const observation = await readGmailMutationEvidence(
        options,
        credential,
        {
          version: 1,
          command: "gmail.mutation-evidence",
          id: action.id,
          accountId: target.connectionId,
          key: `gmail-check:${createHash("sha256")
            .update(JSON.stringify([action.id, request.key]))
            .digest("hex")}`,
        },
        signal,
      );
      if (observation.status !== "ok")
        return observation.status === "waiting" || observation.status === "denied"
          ? observation
          : uncertain(action.id);
      const evidence = gmailReconciliationEvidenceSchema.parse(observation.data);
      if (
        !evidence.matched ||
        !evidence.receipt ||
        evidence.operationId !== action.operationId ||
        evidence.source.connectionId !== target.connectionId ||
        evidence.source.connectionRevision !== target.connectionRevision ||
        evidence.source.preferencesRevision !== target.preferencesRevision ||
        evidence.source.task?.id !== authority.taskId
      )
        return uncertain(action.id);
      const receipt = evidence.receipt;
      signal.throwIfAborted();
      const reconciled = await database.transaction(ownerId, async (scope) => {
        const current = await scope.capabilities.authenticate(credential);
        if (
          current?.operation !== "gateway:control" ||
          current.taskId !== authority.taskId ||
          current.revision !== authority.revision ||
          current.generation !== authority.generation
        )
          return null;
        const connection = await scope.connections.find(target.connectionId);
        const preferences = await scope.connectionTargets.preferences();
        const readAction = await scope.actions.find(evidence.readActionId);
        if (
          readAction?.state !== "succeeded" ||
          readAction.request.authorization.operation !== "gmail.read" ||
          readAction.request.authorization.target.id !== target.connectionId ||
          readAction.request.task.id !== authority.taskId
        )
          return null;
        const policy = await scope.authorization.evaluate(
          readAction.request.authorization,
          readAction.snapshot ?? undefined,
        );
        if (
          connection?.revision !== target.connectionRevision ||
          preferences.revision !== target.preferencesRevision ||
          policy.decision === "deny" ||
          (policy.decision === "ask" && readAction.decisionSource !== "owner") ||
          !(await scope.responsibilityAccess(authority.taskId, readAction.request.authorization))
        )
          return null;
        return scope.actions.reconcile(action.id, action.operationId, {
          state: "succeeded",
          providerReference: JSON.stringify(receipt),
          detail: !("prepared" in plan)
            ? "An authorized provider read found the requested message state. This does not establish who performed the change or when it happened. No write was resent."
            : "An authorized provider read found the exact approved MIME content in the expected mailbox state. This does not establish who performed the action or confirm recipient delivery or draft removal. No write was resent.",
        });
      });
      return reconciled
        ? {
            version: 1,
            status: "ok",
            data: { actionId: reconciled.id, state: reconciled.state, outcome: reconciled.outcome },
          }
        : uncertain(action.id);
    } catch {
      return uncertain(request.id);
    }
  };
}
