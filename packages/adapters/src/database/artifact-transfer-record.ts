import { sql } from "drizzle-orm";
import { artifactTransferSchema } from "@winston/contracts/artifacts";
import type { DatabaseTransaction } from "./owners";

export type ArtifactTransferRow = {
  id: string;
  actionId: string;
  state: "pending" | "active" | "unknown" | "staged";
  capabilityId: string | null;
  descriptor: unknown;
  receipt: unknown;
  live: boolean;
};

export async function findArtifactTransfer(
  transaction: DatabaseTransaction,
  ownerId: string,
  inputId: string,
) {
  const id = artifactTransferSchema.shape.transferId.parse(inputId);
  const result = await transaction.execute<ArtifactTransferRow>(sql`
    SELECT id, action_id AS "actionId", state, source_capability_id AS "capabilityId",
      descriptor, receipt, COALESCE(expires_at > clock_timestamp(), false) AS live
    FROM winston.artifact_transfers WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid FOR UPDATE
  `);
  return result.rows[0] ?? null;
}
