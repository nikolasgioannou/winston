import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "./owners";

export type DeviceWriteRecord = {
  actionId: string;
  transferId: string;
  workspaceId: string;
  workspaceRevision: number;
  artifactId: string;
  artifactRevision: number;
  sourceActionId: string | null;
  stagingTransferId: string | null;
};

export async function findDeviceWrite(
  transaction: DatabaseTransaction,
  ownerId: string,
  actionId: string,
) {
  const rows = await transaction.execute<DeviceWriteRecord>(sql`
    SELECT action_id AS "actionId", transfer_id AS "transferId",
      workspace_id AS "workspaceId", workspace_revision AS "workspaceRevision",
      artifact_id AS "artifactId", artifact_revision AS "artifactRevision",
      source_action_id AS "sourceActionId", staging_transfer_id AS "stagingTransferId"
    FROM winston.device_file_writes
    WHERE owner_id = ${ownerId}::uuid AND action_id = ${actionId}::uuid
    FOR SHARE
  `);
  return rows.rows[0] ?? null;
}
