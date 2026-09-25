import { sql } from "drizzle-orm";
import type { ActionRecord } from "@winston/contracts/actions";
import { deviceFileSourceSchema, type DeviceFileOrigin } from "@winston/contracts/artifacts";
import { deviceExecutionSchema } from "@winston/contracts/device-executions";
import { canonicalJson } from "@winston/contracts/json";
import type { DatabaseTransaction } from "./owners";

// Captured bytes do not require a live session, but must retain the completed read's proof.
export async function deviceArtifactEvidence(
  transaction: DatabaseTransaction,
  ownerId: string,
  action: ActionRecord,
  input: DeviceFileOrigin,
) {
  const origin = deviceFileSourceSchema.shape.origin.parse(input);
  const { target, operation } = action.request.authorization;
  const expected = {
    kind: "file.read",
    path: origin.path,
    transferId: origin.transferId,
  };
  if (
    action.id !== origin.readActionId ||
    target.kind !== "device" ||
    target.id !== origin.deviceId ||
    target.resource !== null ||
    operation !== "device.file.read" ||
    action.operationId !== origin.executionId ||
    canonicalJson(action.request.arguments) !== canonicalJson(expected) ||
    action.outcome?.state !== "succeeded" ||
    action.outcome.providerReference !== origin.executionId
  )
    return false;

  const rows = await transaction.execute<{ document: unknown }>(sql`
    SELECT document FROM winston.device_executions
    WHERE owner_id = ${ownerId}::uuid AND device_id = ${origin.deviceId}::uuid
      AND execution_id = ${origin.executionId}::uuid AND action_id = ${action.id}::uuid
      AND state = 'succeeded'
    FOR SHARE
  `);
  const parsed = deviceExecutionSchema.safeParse(rows.rows[0]?.document);
  if (!parsed.success) return false;
  const execution = parsed.data;
  const payload = execution.message.payload;
  return (
    execution.state === "succeeded" &&
    execution.actionId === action.id &&
    execution.message.deviceId === origin.deviceId &&
    canonicalJson(execution.task) === canonicalJson(action.dispatchTask) &&
    payload.kind === "execute" &&
    payload.executionId === origin.executionId &&
    payload.taskId === action.request.task.id &&
    payload.taskRevision === execution.task.revision &&
    canonicalJson(payload.operation) === canonicalJson(expected)
  );
}
