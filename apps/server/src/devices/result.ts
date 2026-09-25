import type { OwnerTransaction } from "@winston/adapters/database";
import { cliDeviceResultSchema, type CliResult } from "@winston/contracts/cli";

export async function deviceCommandResult(
  scope: Pick<OwnerTransaction, "actions" | "deviceExecutions" | "authorization">,
  taskId: string,
  id: string,
  after = -1,
): Promise<CliResult> {
  const action = await scope.actions.find(id);
  if (
    !action ||
    action.request.task.id !== taskId ||
    action.request.authorization.target.kind !== "device" ||
    action.request.authorization.operation !== "device.command"
  )
    return { version: 1, status: "denied", message: "Operation unavailable to this task." };
  const policy = await scope.authorization.evaluate(
    action.request.authorization,
    action.snapshot ?? undefined,
  );
  if (
    policy.decision === "deny" ||
    (policy.decision === "ask" && action.decisionSource !== "owner")
  )
    return { version: 1, status: "denied", message: "This command result is no longer permitted." };
  const execution = await scope.deviceExecutions.find(action.operationId);
  if (!execution)
    return {
      version: 1,
      status: "unknown",
      referenceId: id,
      message: "No execution receipt is available. Do not repeat an uncertain command.",
    };
  const page = await scope.deviceExecutions.listOutput(action.operationId, after);
  const evidence = execution.reconciliation?.response?.payload ?? execution.receipt?.payload;
  const exitCode =
    evidence?.kind === "status" || evidence?.kind === "reconciled" ? evidence.exitCode : null;
  const data = cliDeviceResultSchema.parse({
    id,
    executionId: action.operationId,
    deviceId: execution.message.deviceId,
    state: execution.state,
    exitCode,
    output: page.messages.map(({ payload }) => {
      if (payload.kind !== "output") throw new Error("Invalid device output.");
      return { sequence: payload.sequence, stream: payload.stream, text: payload.text };
    }),
    afterSequence: page.afterSequence,
    hasMore: page.hasMore,
  });
  return { version: 1, status: "ok", data };
}
