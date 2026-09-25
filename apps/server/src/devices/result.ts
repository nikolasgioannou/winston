import type { OwnerTransaction } from "@winston/adapters/database";
import type { ActionTask } from "@winston/contracts/actions";
import { deviceFileArtifactSchema } from "@winston/contracts/artifacts";
import { cliDeviceResultSchema, cliResultSchema, type CliResult } from "@winston/contracts/cli";

export async function deviceCommandResult(
  scope: Pick<OwnerTransaction, "actions" | "deviceExecutions" | "authorization" | "artifacts">,
  worker: ActionTask,
  id: string,
  after = -1,
): Promise<CliResult> {
  const action = await scope.actions.find(id);
  if (
    !action ||
    action.request.task.id !== worker.id ||
    action.request.authorization.target.kind !== "device" ||
    !["device.command", "device.file.read", "device.file.write"].includes(
      action.request.authorization.operation,
    )
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
    return {
      version: 1,
      status: "denied",
      message: "This operation result is no longer permitted.",
    };
  const execution = await scope.deviceExecutions.find(action.operationId);
  if (!execution)
    return {
      version: 1,
      status: "unknown",
      referenceId: id,
      message: "No execution receipt is available. Do not repeat an uncertain operation.",
    };
  let artifact;
  if (
    action.request.authorization.operation === "device.file.read" &&
    execution.state === "succeeded"
  ) {
    const source = deviceFileArtifactSchema.safeParse(
      await scope.artifacts.findByKey(`device-file:${action.id}`),
    );
    if (!source.success || source.data.state !== "ready" || action.state !== "succeeded")
      return {
        version: 1,
        status: "unavailable",
        referenceId: id,
        message:
          "The captured file receipt is unavailable. Inspect this operation before retrying.",
      };
    const { origin, reference } = source.data.metadata.source;
    if (
      reference !== `device:${origin.deviceId}:${origin.executionId}` ||
      !(await scope.actions.authorizeCompletedArtifactReceipt({
        id: action.id,
        taskId: worker.id,
        intentRevision: action.intentRevision,
        worker,
        proof: { kind: "device-source", origin },
      }))
    )
      return {
        version: 1,
        status: "denied",
        referenceId: id,
        message: "The captured file is no longer permitted.",
      };
    const { name, mediaType, size, sha256 } = source.data.metadata;
    artifact = {
      id: source.data.id,
      revision: source.data.revision,
      name,
      mediaType,
      size,
      sha256,
    };
  }
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
    ...(artifact ? { artifact } : {}),
    output: page.messages.map(({ payload }) => {
      if (payload.kind !== "output") throw new Error("Invalid device output.");
      return { sequence: payload.sequence, stream: payload.stream, text: payload.text };
    }),
    afterSequence: page.afterSequence,
    hasMore: page.hasMore,
  });
  return cliResultSchema.parse({ version: 1, status: "ok", data });
}
