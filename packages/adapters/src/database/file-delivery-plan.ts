import { sql } from "drizzle-orm";
import { fileDeliveryPlanSchema } from "@winston/contracts/artifacts";
import type { DatabaseTransaction } from "./owners";
import { artifactRepository } from "./artifacts";
import { stagedArtifactDeliveryProof } from "./artifact-delivery-proof";

export async function fileDeliveryPlan(
  transaction: DatabaseTransaction,
  ownerId: string,
  input: {
    artifactId: string;
    workspaceId: string;
    taskId: string;
    intentRevision: number;
    botId: number;
  },
  pinnedTransferId?: string,
) {
  const artifact = await artifactRepository(transaction, ownerId).find(input.artifactId, true);
  if (artifact?.state !== "ready") return null;
  let stagingTransferId: string | null = null;
  if (artifact.metadata.source.kind === "workspace") {
    if (
      pinnedTransferId ||
      artifact.metadata.source.reference !==
        `workspace:${input.workspaceId}/task:${input.taskId}/intent:${String(input.intentRevision)}`
    )
      return null;
  } else {
    stagingTransferId = await stagedArtifactDeliveryProof(transaction, ownerId, {
      artifact,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      intentRevision: input.intentRevision,
      ...(pinnedTransferId ? { transferId: pinnedTransferId } : {}),
    });
    if (!stagingTransferId) return null;
  }
  const binding = await transaction.execute<{ chatId: string }>(sql`
    SELECT chat_id::text AS "chatId" FROM winston.telegram_bindings
    WHERE owner_id = ${ownerId}::uuid AND bot_id = ${input.botId}
  `);
  if (!binding.rows[0]) return null;
  return fileDeliveryPlanSchema.parse({
    version: 1,
    artifactId: artifact.id,
    artifactRevision: artifact.revision,
    workspaceId: input.workspaceId,
    stagingTransferId,
    botId: input.botId,
    chatId: binding.rows[0].chatId,
    name: artifact.metadata.name,
    mediaType: artifact.metadata.mediaType,
    size: artifact.metadata.size,
    sha256: artifact.metadata.sha256,
  });
}
