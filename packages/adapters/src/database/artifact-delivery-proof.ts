import { sql } from "drizzle-orm";
import {
  artifactStagePlanSchema,
  artifactStageReceiptSchema,
  artifactTransferSchema,
  type Artifact,
} from "@winston/contracts/artifacts";
import type { DatabaseTransaction } from "./owners";
import { actionRepository } from "./actions";
import { findArtifactTransfer } from "./artifact-transfer-record";
import { findWorkspace } from "./workspace-record";
import { artifactSourceProof } from "./artifact-source-proof";

export async function stagedArtifactDeliveryProof(
  transaction: DatabaseTransaction,
  ownerId: string,
  input: {
    artifact: Artifact;
    workspaceId: string;
    taskId: string;
    intentRevision: number;
    transferId?: string;
  },
) {
  const source = await artifactSourceProof(transaction, ownerId, input.artifact);
  if (!source) return null;
  const artifact = source.artifact;
  const candidates = await transaction.execute<{ id: string }>(sql`
    SELECT id FROM winston.artifact_transfers
    WHERE owner_id = ${ownerId}::uuid AND artifact_id = ${artifact.id}::uuid
      AND workspace_id = ${input.workspaceId}::uuid AND task_id = ${input.taskId}::uuid
      AND intent_revision = ${input.intentRevision} AND state = 'staged'
      AND (${input.transferId ?? null}::uuid IS NULL OR id = ${input.transferId ?? null}::uuid)
    ORDER BY id LIMIT 1
  `);
  if (!candidates.rows[0]) return null;
  const row = await findArtifactTransfer(transaction, ownerId, candidates.rows[0].id);
  if (row?.state !== "staged") return null;
  const descriptor = artifactTransferSchema.safeParse(row.descriptor);
  const receipt = artifactStageReceiptSchema.safeParse(row.receipt);
  if (!descriptor.success || !receipt.success) return null;
  const transfer = descriptor.data;
  if (
    transfer.ownerId !== ownerId ||
    transfer.transferId !== row.id ||
    transfer.workspaceId !== input.workspaceId ||
    transfer.task.id !== input.taskId ||
    transfer.artifactId !== artifact.id ||
    transfer.artifactRevision !== artifact.revision ||
    transfer.size !== artifact.metadata.size ||
    transfer.sha256 !== artifact.metadata.sha256 ||
    receipt.data.path !== `/data/inbox/${artifact.id}` ||
    receipt.data.size !== transfer.size ||
    receipt.data.sha256 !== transfer.sha256
  )
    return null;
  const workspace = await findWorkspace(transaction, ownerId, input.workspaceId, true);
  if (workspace?.state !== "active" || workspace.revision !== transfer.workspaceRevision)
    return null;
  const actions = actionRepository(transaction, ownerId);
  const staging = await actions.find(row.actionId);
  const planned = artifactStagePlanSchema.safeParse(staging?.request.arguments);
  if (!planned.success) return null;
  const plan = planned.data;
  if (
    plan.request.id !== artifact.id ||
    plan.request.revision !== artifact.revision ||
    plan.workspaceId !== transfer.workspaceId ||
    plan.workspaceRevision !== transfer.workspaceRevision ||
    plan.size !== transfer.size ||
    plan.sha256 !== transfer.sha256 ||
    plan.sourceReadActionId !== source.readActionId
  )
    return null;
  const sourceAllowed = await actions.authorizeCompletedArtifactReceipt({
    id: plan.sourceReadActionId,
    taskId: input.taskId,
    intentRevision: input.intentRevision,
    proof: source.proof,
  });
  const stageAllowed =
    sourceAllowed &&
    (await actions.authorizeCompletedArtifactReceipt({
      id: row.actionId,
      taskId: input.taskId,
      intentRevision: input.intentRevision,
      proof: { kind: "staging", transferId: row.id, plan },
    }));
  return stageAllowed ? row.id : null;
}
