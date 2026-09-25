import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  artifactStagePlanSchema,
  artifactStageRequestSchema,
  type ArtifactStageRequest,
} from "@winston/contracts/artifacts";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { canonicalJson } from "@winston/contracts/json";
import type { DatabaseTransaction } from "./owners";
import { capabilityRepository } from "./capabilities";
import { actionRepository } from "./actions";
import { authorizedStageSource } from "./artifact-stage-source";
import { findArtifactTransfer } from "./artifact-transfer-record";

export async function prepareArtifactStaging(
  transaction: DatabaseTransaction,
  ownerId: string,
  credential: ServiceRequest,
  input: ArtifactStageRequest,
) {
  const request = artifactStageRequestSchema.parse(input);
  await transaction.execute(
    sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
  );
  const authority = await capabilityRepository(transaction, ownerId).authenticate(credential);
  if (authority?.operation !== "gateway:control" || authority.resourceRevision === undefined)
    return null;
  const task = {
    id: authority.taskId,
    revision: authority.revision,
    generation: authority.generation,
  };
  const source = await authorizedStageSource(transaction, ownerId, task, request);
  if (!source) return null;
  const plan = artifactStagePlanSchema.parse({
    request,
    workspaceId: authority.resourceId,
    workspaceRevision: authority.resourceRevision,
    size: source.artifact.metadata.size,
    sha256: source.artifact.metadata.sha256,
    sourceReadActionId: source.readActionId,
  });
  const rows = await transaction.execute<{ intent: number }>(sql`
    SELECT intent_revision AS intent FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${task.id}::uuid
  `);
  const current = rows.rows[0];
  if (!current) return null;
  const key = `stage:${task.id}:${String(current.intent)}:${createHash("sha256").update(request.key).digest("hex")}`;
  const existing = await transaction.execute<{ id: string }>(sql`
    SELECT id FROM winston.artifact_transfers WHERE owner_id = ${ownerId}::uuid AND request_key = ${key}
  `);
  const actions = actionRepository(transaction, ownerId);
  const previous = existing.rows[0]
    ? await findArtifactTransfer(transaction, ownerId, existing.rows[0].id)
    : null;
  const target = { kind: "workspace" as const, id: plan.workspaceId, resource: null };
  const action = previous
    ? await actions.find(previous.actionId)
    : await actions.prepare({
        key,
        task,
        authorization: { target, operation: "workspace.file.write" },
        arguments: plan,
      });
  if (
    !action ||
    canonicalJson(action.request.arguments) !== canonicalJson(plan) ||
    canonicalJson(action.request.authorization.target) !== canonicalJson(target)
  )
    throw new Error("Staging key conflicts with its original artifact or workspace.");
  if (!previous) {
    await transaction.execute(sql`
      INSERT INTO winston.artifact_transfers (owner_id, id, action_id, task_id, intent_revision, workspace_id, artifact_id, request_key)
      VALUES (${ownerId}::uuid, ${action.operationId}::uuid, ${action.id}::uuid, ${task.id}::uuid,
        ${current.intent}, ${plan.workspaceId}::uuid, ${request.id}::uuid, ${key})
    `);
  }
  const row = previous ?? (await findArtifactTransfer(transaction, ownerId, action.operationId));
  if (!row) throw new Error("Staging record unavailable.");
  return { row, action, task, plan, capabilityId: authority.capabilityId };
}
