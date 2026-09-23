import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { actionTaskSchema, actionRecordSchema, type ActionTask } from "@winston/contracts/actions";
import { canonicalJson } from "@winston/contracts/json";
import { taskSchema } from "@winston/contracts/tasks";
import {
  taskStepRequestSchema,
  taskStepSchema,
  type TaskStepRequest,
} from "@winston/contracts/task-steps";
import type { DatabaseTransaction } from "./owners";
import { workspaceCommandToolInputSchema } from "@winston/contracts/workspace-commands";
import { actionRepository } from "./actions";

export function taskStepRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function current(input: ActionTask) {
    const worker = actionTaskSchema.parse(input);
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
    const rows = await transaction.execute<{
      document: unknown;
      intentRevision: number;
      live: boolean;
    }>(sql`
      SELECT document, intent_revision AS "intentRevision", leased_until > clock_timestamp() AS live
      FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${worker.id}::uuid FOR UPDATE
    `);
    const row = rows.rows[0];
    if (!row) throw new Error("Task unavailable.");
    const task = taskSchema.parse(row.document);
    if (
      !row.live ||
      task.state !== "running" ||
      task.revision !== worker.revision ||
      task.generation !== worker.generation
    )
      throw new Error("Worker lease is stale or expired.");
    return { worker, intentRevision: row.intentRevision };
  }

  return {
    async recent(input: ActionTask, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("Invalid checkpoint window.");
      const { worker, intentRevision } = await current(input);
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.task_steps WHERE owner_id = ${ownerId}::uuid
          AND task_id = ${worker.id}::uuid AND intent_revision = ${intentRevision}
        ORDER BY sequence DESC LIMIT ${limit + 1}
      `);
      return {
        intentRevision,
        steps: rows.rows
          .slice(0, limit)
          .reverse()
          .map((row) => taskStepSchema.parse(row.document)),
        hasEarlier: rows.rows.length > limit,
      };
    },
    async prepareWorkspace(input: ActionTask, inputStepId: string, callId: string) {
      const stepId = taskStepSchema.shape.id.parse(inputStepId);
      const { worker, intentRevision } = await current(input);
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.task_steps WHERE owner_id = ${ownerId}::uuid
          AND task_id = ${worker.id}::uuid AND intent_revision = ${intentRevision} AND id = ${stepId}::uuid
      `);
      const model = rows.rows[0]
        ? taskStepSchema.parse(rows.rows[0].document).request.payload
        : null;
      const call =
        model?.kind === "model" ? model.calls.find((entry) => entry.id === callId) : undefined;
      if (!call || call.name !== "workspace_command")
        throw new Error("Workspace model call unavailable.");
      const command = workspaceCommandToolInputSchema.parse(call.input);
      const key = `step:${stepId}:${createHash("sha256").update(call.id).digest("hex")}`;
      const previous = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.actions WHERE owner_id = ${ownerId}::uuid
          AND task_id = ${worker.id}::uuid AND request_key = ${key}
      `);
      if (previous.rows[0]) {
        const action = actionRecordSchema.parse(previous.rows[0].document);
        if (
          action.intentRevision !== intentRevision ||
          action.request.authorization.target.kind !== "workspace" ||
          action.request.authorization.target.id !== command.workspaceId ||
          action.request.authorization.operation !== "workspace.command" ||
          canonicalJson(action.request.arguments) !== canonicalJson(command.command)
        )
          throw new Error("Workspace action conflicts with its model call.");
        return action;
      }
      // This record is committed before any dispatcher may contact the workspace. Its identity
      // survives lease recovery; the immutable original request is never rewritten for a new worker.
      return actionRepository(transaction, ownerId).prepare({
        key,
        task: worker,
        authorization: {
          target: { kind: "workspace", id: command.workspaceId, resource: null },
          operation: "workspace.command",
        },
        arguments: command.command,
      });
    },
    async list(input: ActionTask, afterSequence = 0, limit = 100) {
      if (
        !Number.isInteger(afterSequence) ||
        afterSequence < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new Error("Invalid checkpoint page.");
      const { worker, intentRevision } = await current(input);
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.task_steps WHERE owner_id = ${ownerId}::uuid
          AND task_id = ${worker.id}::uuid AND intent_revision = ${intentRevision}
          AND sequence > ${afterSequence} ORDER BY sequence LIMIT ${limit + 1}
      `);
      return {
        intentRevision,
        steps: rows.rows.slice(0, limit).map((row) => taskStepSchema.parse(row.document)),
        hasMore: rows.rows.length > limit,
      };
    },
    async append(input: ActionTask, value: TaskStepRequest) {
      const request = taskStepRequestSchema.parse(value);
      const { worker, intentRevision } = await current(input);
      const existing = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.task_steps WHERE owner_id = ${ownerId}::uuid
          AND task_id = ${worker.id}::uuid AND intent_revision = ${intentRevision} AND request_key = ${request.key}
      `);
      if (existing.rows[0]) {
        const previous = taskStepSchema.parse(existing.rows[0].document);
        if (canonicalJson(previous.request) !== canonicalJson(request))
          throw new Error("Checkpoint replay conflicts with its original request.");
        return previous;
      }
      const tail = await transaction.execute<{ sequence: number }>(sql`
        SELECT sequence FROM winston.task_steps WHERE owner_id = ${ownerId}::uuid
          AND task_id = ${worker.id}::uuid AND intent_revision = ${intentRevision} ORDER BY sequence DESC LIMIT 1
      `);
      if ((tail.rows[0]?.sequence ?? 0) !== request.afterSequence)
        throw new Error("Checkpoint sequence changed.");
      const payload = request.payload;
      if (payload.kind === "tool") {
        const models = await transaction.execute<{ document: unknown }>(sql`
          SELECT document FROM winston.task_steps WHERE owner_id = ${ownerId}::uuid
            AND task_id = ${worker.id}::uuid AND intent_revision = ${intentRevision} AND id = ${payload.modelStepId}::uuid
        `);
        const model = models.rows[0]
          ? taskStepSchema.parse(models.rows[0].document).request.payload
          : null;
        if (model?.kind !== "model" || !model.calls.some((call) => call.id === payload.callId))
          throw new Error("Tool result has no matching model call.");
        if (payload.actionId) {
          const actions = await transaction.execute<{ document: unknown }>(sql`
            SELECT document FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND id = ${payload.actionId}::uuid
          `);
          const action = actions.rows[0]
            ? actionRecordSchema.parse(actions.rows[0].document)
            : null;
          if (
            !action ||
            action.request.task.id !== worker.id ||
            action.intentRevision !== intentRevision
          )
            throw new Error("Action is unrelated to this task intent.");
        }
      }
      const step = taskStepSchema.parse({
        id: randomUUID(),
        task: worker,
        intentRevision,
        sequence: request.afterSequence + 1,
        request,
      });
      await transaction.execute(sql`
        INSERT INTO winston.task_steps (owner_id, task_id, intent_revision, sequence, id, request_key, document)
        VALUES (${ownerId}::uuid, ${worker.id}::uuid, ${intentRevision}, ${step.sequence}, ${step.id}::uuid,
          ${request.key}, ${JSON.stringify(step)}::jsonb)
      `);
      return step;
    },
  };
}
