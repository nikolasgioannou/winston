import { sql } from "drizzle-orm";
import {
  deviceExecutionSchema,
  deviceFileAuthoritySchema,
  type DeviceFileAuthority,
} from "@winston/contracts/device-executions";
import { deviceSessionIdentitySchema } from "@winston/contracts/device-registry";
import type { DatabaseTransaction } from "./owners";

// Call inside the owner's locked transaction. The authenticated device ID comes from the
// server credential check, independently of the session identity supplied in a request.
export async function reservedDeviceFile(
  transaction: DatabaseTransaction,
  ownerId: string,
  authenticatedDeviceId: string,
  input: DeviceFileAuthority,
) {
  const deviceId = deviceSessionIdentitySchema.shape.deviceId.parse(authenticatedDeviceId);
  const proof = deviceFileAuthoritySchema.parse(input);
  if (proof.session.deviceId !== deviceId) return null;
  const rows = await transaction.execute<{ document: unknown }>(sql`
    SELECT document FROM winston.device_executions
    WHERE owner_id = ${ownerId}::uuid AND device_id = ${deviceId}::uuid
      AND execution_id = ${proof.executionId}::uuid
      AND session_id = ${proof.session.sessionId}::uuid AND generation = ${proof.session.generation}
      AND state IN ('dispatching', 'accepted', 'running') AND deadline > clock_timestamp()
    FOR SHARE
  `);
  if (!rows.rows[0]) return null;
  const execution = deviceExecutionSchema.parse(rows.rows[0].document);
  const { message } = execution;
  const payload = message.payload;
  if (
    !["dispatching", "accepted", "running"].includes(execution.state) ||
    message.deviceId !== deviceId ||
    message.sessionId !== proof.session.sessionId ||
    message.generation !== proof.session.generation ||
    payload.kind !== "execute" ||
    payload.executionId !== proof.executionId ||
    (payload.operation.kind !== "file.read" && payload.operation.kind !== "file.write") ||
    payload.operation.kind !== proof.operation ||
    payload.operation.transferId !== proof.transferId
  )
    return null;
  return execution;
}
