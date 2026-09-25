import type { FilePublication } from "@winston/contracts/artifacts";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CliResult } from "@winston/contracts/cli";
import type { createDatabase } from "../database";

export async function prepareWorkspaceFilePublication(
  database: ReturnType<typeof createDatabase>,
  ownerId: string,
  credential: ServiceRequest,
  request: FilePublication,
) {
  return database.transaction(ownerId, async (scope) => {
    const result = (
      status: "denied" | "waiting" | "unknown" | "unavailable",
      message: string,
      referenceId?: string,
    ) => ({
      kind: "result" as const,
      result: {
        version: 1,
        status,
        message,
        ...(referenceId ? { referenceId } : {}),
      } satisfies CliResult,
    });
    const prepared = await scope.filePublications.prepare(credential, request);
    if (!prepared) return result("denied", "File publication authority is unavailable or expired.");
    let action = prepared.action;
    const policy = await scope.authorization.evaluate(
      action.request.authorization,
      action.snapshot ?? undefined,
    );
    if (policy.decision === "deny")
      return result("denied", "File publication policy or resource changed.", action.id);
    if (action.state === "dispatching") action = (await scope.actions.recover(action.id)) ?? action;
    if (action.state === "pending") {
      const current = await scope.actions.expirePending(action.id);
      if (current?.state !== "pending")
        return result("denied", "File publication approval expired.", action.id);
      const task = prepared.task;
      await scope.tasks.finishStep(task.id, task.revision, task.generation, {
        state: "waiting",
        blocker: {
          kind: "approval",
          referenceId: action.id,
          detail: "Waiting for permission to publish this exact file.",
        },
      });
      return result(
        "waiting",
        "Waiting for approval to publish this exact file. Resume with the same key and file.",
        action.id,
      );
    }
    if (["denied", "invalidated"].includes(action.state))
      return result("denied", "This file publication is no longer permitted.", action.id);
    if (action.state === "failed")
      return result("unavailable", "This file publication failed.", action.id);
    if (action.state === "succeeded" || action.state === "unknown")
      return { kind: "receipt" as const, ...prepared, action };
    const unresolved = await scope.actions.unresolvedPriorEffect(prepared.task);
    if (unresolved)
      return result("unknown", "An earlier task action is still unresolved.", unresolved.id);
    const claim = await scope.actions.claim(action.id, action.hash, prepared.task);
    if (claim && ["denied", "invalidated"].includes(claim.action.state))
      return result("denied", "File publication approval is no longer valid.", action.id);
    if (!claim?.claimed)
      return result(
        "unknown",
        "File publication has no confirmed reusable result. It will not be uploaded again.",
        action.id,
      );
    return { kind: "dispatch" as const, ...prepared, action: claim.action, token: claim.token };
  });
}
