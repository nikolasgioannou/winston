import { sql } from "drizzle-orm";
import { artifactStagePlanSchema, type ArtifactTransfer } from "@winston/contracts/artifacts";
import { serviceScopeSchema } from "@winston/contracts/capabilities";
import type { DatabaseTransaction } from "./owners";
import { actionRepository } from "./actions";
import { findWorkspace } from "./workspace-record";
import { authorizedStageSource } from "./artifact-stage-source";

export async function currentArtifactTransfer(
  transaction: DatabaseTransaction,
  ownerId: string,
  input: { actionId: string; capabilityId: string; transfer: ArtifactTransfer },
) {
  const { transfer } = input;
  if (transfer.ownerId !== ownerId) return null;
  const workspace = await findWorkspace(transaction, ownerId, transfer.workspaceId, true);
  if (workspace?.state !== "active" || workspace.revision !== transfer.workspaceRevision)
    return null;
  const capabilities = await transaction.execute<{ document: unknown }>(sql`
    SELECT document FROM winston.service_capabilities
    WHERE owner_id = ${ownerId}::uuid AND id = ${input.capabilityId}::uuid
      AND revoked_at IS NULL AND expires_at > clock_timestamp()
    FOR SHARE
  `);
  const scope = serviceScopeSchema.safeParse(capabilities.rows[0]?.document);
  if (
    !scope.success ||
    scope.data.kind !== "workspace" ||
    scope.data.operation !== "gateway:control" ||
    scope.data.subjectId !== transfer.workspaceId ||
    scope.data.resourceId !== transfer.workspaceId ||
    scope.data.resourceRevision !== transfer.workspaceRevision ||
    scope.data.taskId !== transfer.task.id ||
    scope.data.revision !== transfer.task.revision ||
    scope.data.generation !== transfer.task.generation ||
    scope.data.credential !== null
  )
    return null;
  const actions = actionRepository(transaction, ownerId);
  const action = await actions.find(input.actionId);
  if (!action || action.operationId !== transfer.transferId) return null;
  const parsed = artifactStagePlanSchema.safeParse(action.request.arguments);
  if (!parsed.success) return null;
  const plan = parsed.data;
  if (
    plan.workspaceId !== transfer.workspaceId ||
    plan.workspaceRevision !== transfer.workspaceRevision ||
    plan.request.id !== transfer.artifactId ||
    plan.request.revision !== transfer.artifactRevision ||
    plan.size !== transfer.size ||
    plan.sha256 !== transfer.sha256
  )
    return null;
  const source = await authorizedStageSource(transaction, ownerId, transfer.task, plan.request);
  if (
    !source ||
    source.readActionId !== plan.sourceReadActionId ||
    source.artifact.metadata.size !== plan.size ||
    source.artifact.metadata.sha256 !== plan.sha256
  )
    return null;
  if (
    !(await actions.authorizeArtifactStaging({
      id: action.id,
      transferId: transfer.transferId,
      task: transfer.task,
      plan,
    }))
  )
    return null;
  // No arbitrary token scope, file identity or task revision is inherited from a caller.
  return { plan, artifact: source.artifact };
}
