import type { CliReadRequest, CliResult } from "@winston/contracts/cli";
import type { GmailReconciliationRead } from "@winston/contracts/gmail-reconciliation";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { createDatabase } from "../database";

export async function prepareReadApproval(
  database: ReturnType<typeof createDatabase>,
  ownerId: string,
  credential: ServiceRequest,
  request: (CliReadRequest & { key: string }) | GmailReconciliationRead,
) {
  return database.transaction(ownerId, async (scope) => {
    const authority = await scope.capabilities.authenticate(credential);
    const result = (
      status: "denied" | "waiting" | "unknown",
      message: string,
      referenceId?: string,
    ) => ({
      kind: "result" as const,
      actionId: referenceId ?? null,
      result: { version: 1 as const, status, message, ...(referenceId ? { referenceId } : {}) },
    });
    if (authority?.operation !== "gateway:control")
      return result("denied", "Task control authority is unavailable or expired.");
    const worker = {
      id: authority.taskId,
      revision: authority.revision,
      generation: authority.generation,
    };
    const receipt = await scope.connectedReads.prepare(worker, request.key, request);
    const action = receipt.action;
    const policy = await scope.authorization.evaluate(
      action.request.authorization,
      action.snapshot ?? undefined,
    );
    if (policy.decision === "deny" || action.state === "denied" || action.state === "invalidated")
      return result("denied", "This read is no longer permitted.", action.id);
    if (receipt.result) {
      if (policy.decision === "ask" && action.decisionSource !== "owner")
        return result("denied", "This read requires a new approval.", action.id);
      return { kind: "result" as const, actionId: action.id, result: receipt.result };
    }
    if (action.state === "pending") {
      const current = await scope.actions.expirePending(action.id);
      if (current?.state !== "pending")
        return result("denied", "This approval expired.", action.id);
      await scope.tasks.finishStep(worker.id, worker.revision, worker.generation, {
        state: "waiting",
        blocker: {
          kind: "approval",
          referenceId: action.id,
          detail: "Waiting for permission to read the selected account.",
        },
      });
      return result(
        "waiting",
        "Waiting for the owner to approve this exact read. Resume with the same key and arguments.",
        action.id,
      );
    }
    const claim = await scope.actions.claim(action.id, action.hash, worker);
    if (!claim?.claimed)
      return result(
        "unknown",
        "This read has no reusable result and will not be repeated automatically.",
        action.id,
      );
    return {
      kind: "dispatch" as const,
      id: action.id,
      token: claim.token,
      task: worker,
      authorization: action.request.authorization,
      arguments: action.request.arguments,
    };
  });
}

export type ReadDispatch = Extract<
  Awaited<ReturnType<typeof prepareReadApproval>>,
  { kind: "dispatch" }
>;

export async function completeRead(
  database: ReturnType<typeof createDatabase>,
  ownerId: string,
  dispatch: ReadDispatch | undefined,
  result: CliResult,
) {
  if (!dispatch) return result;
  const recorded = await database.transaction(ownerId, ({ connectedReads }) =>
    connectedReads.complete(dispatch.id, dispatch.token, result),
  );
  if (!recorded) throw new Error("Read result could not be recorded.");
  return recorded;
}
