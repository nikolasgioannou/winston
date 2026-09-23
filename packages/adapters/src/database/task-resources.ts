import { sql } from "drizzle-orm";
import { canonicalJson } from "@winston/contracts/json";
import { taskSchema } from "@winston/contracts/tasks";
import {
  authorizationRequestSchema,
  type AuthorizationRequest,
} from "@winston/contracts/authorization";
import {
  taskResourceBindingSchema,
  taskResourceKeySchema,
  taskResourceRequestSchema,
  taskResourceScopeSchema,
  type TaskResourceScope,
  type TaskResourceRequest,
} from "@winston/contracts/task-resources";
import type { DatabaseTransaction } from "./owners";
import { authorizationRepository } from "./authorization";

export function taskResourceRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function current(input: TaskResourceScope) {
    const scope = taskResourceScopeSchema.parse(input);
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
    const rows = await transaction.execute<{ document: unknown; intentRevision: number }>(sql`
      SELECT document, intent_revision AS "intentRevision" FROM winston.tasks
      WHERE owner_id = ${ownerId}::uuid AND id = ${scope.id}::uuid FOR UPDATE
    `);
    const row = rows.rows[0];
    if (!row) throw new Error("Task is unavailable to this owner.");
    const task = taskSchema.parse(row.document);
    if (task.revision !== scope.revision) throw new Error("Task revision is stale.");
    return { task, intentRevision: row.intentRevision };
  }
  async function find(taskId: string, intentRevision: number, key: string) {
    const rows = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.task_resource_bindings WHERE owner_id = ${ownerId}::uuid
        AND task_id = ${taskId}::uuid AND intent_revision = ${intentRevision} AND binding_key = ${key}
    `);
    return rows.rows[0] ? taskResourceBindingSchema.parse(rows.rows[0].document) : undefined;
  }
  return {
    async find(scope: TaskResourceScope, inputKey: string) {
      const key = taskResourceKeySchema.parse(inputKey);
      const { task, intentRevision } = await current(scope);
      return find(task.id, intentRevision, key);
    },
    async list(scope: TaskResourceScope) {
      const { task, intentRevision } = await current(scope);
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.task_resource_bindings WHERE owner_id = ${ownerId}::uuid
          AND task_id = ${task.id}::uuid AND intent_revision = ${intentRevision}
        ORDER BY binding_key LIMIT 100
      `);
      return rows.rows.map((row) => taskResourceBindingSchema.parse(row.document));
    },
    async bind(input: TaskResourceRequest) {
      const request = taskResourceRequestSchema.parse(input);
      const { task, intentRevision } = await current(request.task);
      if (!["queued", "running", "waiting"].includes(task.state))
        throw new Error("Task is terminal.");
      const evaluation = await authorizationRepository(transaction, ownerId).evaluate(
        request.authorization,
      );
      if (evaluation.decision === "deny" || evaluation.resourceRevision === null)
        throw new Error("Resource unavailable or denied.");
      const previous = await find(task.id, intentRevision, request.key);
      if (previous) {
        if (canonicalJson(previous.authorization) !== canonicalJson(request.authorization))
          throw new Error("Steer the task before changing its target.");
        return previous;
      }
      const count = await transaction.execute<{ count: number }>(sql`
        SELECT count(*)::integer AS count FROM winston.task_resource_bindings WHERE owner_id = ${ownerId}::uuid
          AND task_id = ${task.id}::uuid AND intent_revision = ${intentRevision}
      `);
      if ((count.rows[0]?.count ?? 100) >= 100) throw new Error("Task resource limit reached.");
      const binding = taskResourceBindingSchema.parse({
        taskId: task.id,
        intentRevision,
        key: request.key,
        authorization: request.authorization,
        resourceRevision: evaluation.resourceRevision,
      });
      await transaction.execute(sql`
        INSERT INTO winston.task_resource_bindings (owner_id, task_id, intent_revision, binding_key, document)
        VALUES (${ownerId}::uuid, ${task.id}::uuid, ${intentRevision}, ${request.key}, ${JSON.stringify(binding)}::jsonb)
      `);
      return binding;
    },
    // A binding selects a resource; every action must separately revalidate live permission.
    async matches(
      taskId: string,
      intentRevision: number,
      inputKey: string,
      input: AuthorizationRequest,
    ) {
      const key = taskResourceKeySchema.parse(inputKey);
      const authorization = authorizationRequestSchema.parse(input);
      const binding = await find(
        taskResourceScopeSchema.shape.id.parse(taskId),
        intentRevision,
        key,
      );
      return !!binding && canonicalJson(binding.authorization) === canonicalJson(authorization);
    },
  };
}
export type TaskResourceRepository = ReturnType<typeof taskResourceRepository>;
