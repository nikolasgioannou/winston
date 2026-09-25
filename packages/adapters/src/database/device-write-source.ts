import { sql } from "drizzle-orm";
import { actionRecordSchema, type ActionTask } from "@winston/contracts/actions";
import { filePublicationSchema, type Artifact } from "@winston/contracts/artifacts";
import { deviceFileSourceSchema, type DeviceFileSource } from "@winston/contracts/devices";
import { canonicalJson } from "@winston/contracts/json";
import type { DatabaseTransaction } from "./owners";
import { artifactRepository } from "./artifacts";
import { actionRepository } from "./actions";
import { stagedArtifactDeliveryProof } from "./artifact-delivery-proof";
import { findWorkspace } from "./workspace-record";

export type DeviceWriteSourceProof =
  { kind: "publication"; actionId: string } | { kind: "staged"; transferId: string };

// Resolve the source independently of the destination grant. Call under the owner lock.
export async function deviceWriteSource(
  transaction: DatabaseTransaction,
  ownerId: string,
  input: {
    worker: ActionTask;
    intentRevision: number;
    workspaceId: string;
    workspaceRevision: number;
    source: DeviceFileSource;
    proof?: DeviceWriteSourceProof;
  },
): Promise<{ artifact: Artifact; proof: DeviceWriteSourceProof } | null> {
  const source = deviceFileSourceSchema.parse(input.source);
  const workspace = await findWorkspace(transaction, ownerId, input.workspaceId, true);
  if (workspace?.state !== "active" || workspace.revision !== input.workspaceRevision) return null;
  const artifact = await artifactRepository(transaction, ownerId).find(source.artifactId, true);
  if (
    artifact?.state !== "ready" ||
    artifact.revision !== source.revision ||
    artifact.metadata.size !== source.size ||
    artifact.metadata.sha256 !== source.sha256 ||
    artifact.object.size !== source.size ||
    artifact.object.sha256 !== source.sha256 ||
    artifact.object.ownerId !== ownerId ||
    artifact.object.id !== artifact.id
  )
    return null;

  if (artifact.metadata.source.kind !== "workspace") {
    if (input.proof && input.proof.kind !== "staged") return null;
    const transferId = await stagedArtifactDeliveryProof(transaction, ownerId, {
      artifact,
      workspaceId: workspace.id,
      taskId: input.worker.id,
      intentRevision: input.intentRevision,
      ...(input.proof?.kind === "staged" ? { transferId: input.proof.transferId } : {}),
    });
    return transferId ? { artifact, proof: { kind: "staged" as const, transferId } } : null;
  }
  if (input.proof && input.proof.kind !== "publication") return null;
  if (
    artifact.metadata.source.reference !==
    `workspace:${workspace.id}/task:${input.worker.id}/intent:${String(input.intentRevision)}`
  )
    return null;
  const rows = await transaction.execute<{ document: unknown }>(sql`
    SELECT action.document FROM winston.actions AS action
    JOIN winston.artifacts AS artifact ON artifact.owner_id = action.owner_id
      AND action.request_key = 'publication:' || artifact.request_key
    WHERE artifact.owner_id = ${ownerId}::uuid AND artifact.id = ${artifact.id}::uuid
    FOR SHARE OF action
  `);
  const parsed = actionRecordSchema.safeParse(rows.rows[0]?.document);
  if (!parsed.success) return null;
  const action = parsed.data;
  if (
    action.state !== "succeeded" ||
    action.outcome?.state !== "succeeded" ||
    action.intentRevision !== input.intentRevision ||
    action.outcome.providerReference !== artifact.id ||
    (input.proof?.kind === "publication" && input.proof.actionId !== action.id)
  )
    return null;
  const publication = filePublicationSchema.safeParse(action.request.arguments);
  if (!publication.success) return null;
  const { name, mediaType, size, sha256 } = artifact.metadata;
  const expected = { version: 1, key: publication.data.key, name, mediaType, size, sha256 };
  if (canonicalJson(publication.data) !== canonicalJson(expected)) return null;
  const allowed = await actionRepository(transaction, ownerId).authorizeFilePublication({
    id: action.id,
    task: input.worker,
    workspaceId: workspace.id,
    publication: publication.data,
  });
  return allowed
    ? { artifact, proof: { kind: "publication" as const, actionId: action.id } }
    : null;
}
