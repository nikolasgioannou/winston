import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { actionRecordSchema } from "@winston/contracts/actions";
import { filePublicationSchema, type FilePublication } from "@winston/contracts/artifacts";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { canonicalJson } from "@winston/contracts/json";
import type { DatabaseTransaction } from "./owners";
import { capabilityRepository } from "./capabilities";
import { actionRepository } from "./actions";

export async function prepareFilePublication(
  transaction: DatabaseTransaction,
  ownerId: string,
  credential: ServiceRequest,
  input: FilePublication,
) {
  const request = filePublicationSchema.parse(input);
  await transaction.execute(
    sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
  );
  const authority = await capabilityRepository(transaction, ownerId).authenticate(credential);
  if (authority?.operation !== "gateway:control") return null;
  const rows = await transaction.execute<{ intentRevision: number }>(sql`
    SELECT intent_revision AS "intentRevision" FROM winston.tasks
    WHERE owner_id = ${ownerId}::uuid AND id = ${authority.taskId}::uuid
  `);
  const current = rows.rows[0];
  if (!current) return null;
  const key = `file:${authority.taskId}:${String(current.intentRevision)}:${createHash("sha256").update(request.key).digest("hex")}`;
  const target = { kind: "workspace" as const, id: authority.resourceId, resource: null };
  const task = {
    id: authority.taskId,
    revision: authority.revision,
    generation: authority.generation,
  };
  const previous = await transaction.execute<{ document: unknown }>(sql`
    SELECT document FROM winston.actions
    WHERE owner_id = ${ownerId}::uuid AND request_key = ${`publication:${key}`}
  `);
  const stored = previous.rows[0];
  let action;
  if (stored) {
    action = actionRecordSchema.parse(stored.document);
    if (
      canonicalJson(action.request.arguments) !== canonicalJson(request) ||
      canonicalJson(action.request.authorization.target) !== canonicalJson(target)
    )
      throw new Error("Publication key conflicts with its original file or workspace.");
  } else {
    action = await actionRepository(transaction, ownerId).prepare({
      key: `publication:${key}`,
      task,
      authorization: { target, operation: "workspace.file.read" },
      arguments: request,
    });
  }
  return { action, task, key };
}
