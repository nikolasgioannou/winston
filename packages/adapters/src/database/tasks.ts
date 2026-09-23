import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  taskSchema,
  taskRequestSchema,
  taskOutcomeSchema,
  type Task,
  type TaskRequest,
  type TaskOutcome,
} from "@winston/contracts/tasks";
import type { DatabaseTransaction } from "./owners";
import { eventRepository } from "./events";
import { actionTaskSchema, type ActionTask } from "@winston/contracts/actions";
import { serializeUserMessage, userMessageSchema } from "@winston/contracts/messages";
import { taskResourceRepository } from "./task-resources";

type TaskRow = { document: unknown; leaseValid: boolean; requestHash: string };

export function taskRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lockOwner() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }
  async function row(id: string, lock = false) {
    const result = await transaction.execute<TaskRow>(sql`
      SELECT document, COALESCE(leased_until > clock_timestamp(), false) AS "leaseValid", request_hash AS "requestHash"
      FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}
    `);

    return result.rows[0];
  }

  async function record(task: Task) {
    await transaction.execute(sql`
      INSERT INTO winston.task_revisions (owner_id, task_id, revision, document)
      VALUES (${ownerId}::uuid, ${task.id}::uuid, ${task.revision}, ${JSON.stringify(task)}::jsonb)
    `);
    await eventRepository(transaction, ownerId).publish({
      key: `${task.id}:${String(task.revision)}`,
      type: "task.changed",
      payload: { taskId: task.id, revision: task.revision, state: task.state },
      destinations: ["task-runtime", "conversation-updates"],
    });
  }

  async function save(task: Task) {
    const parsed = taskSchema.parse(task);
    await transaction.execute(sql`
      UPDATE winston.tasks SET document = ${JSON.stringify(parsed)}::jsonb,
        leased_until = ${parsed.state === "running" ? sql`clock_timestamp() + interval '60 seconds'` : sql`NULL`}
      WHERE owner_id = ${ownerId}::uuid AND id = ${parsed.id}::uuid
    `);
    await record(parsed);

    return parsed;
  }

  async function current(id: string, revision: number) {
    // Use the same owner → task ordering as action dispatch and policy changes.
    await lockOwner();
    const stored = await row(id, true);
    if (!stored) throw new Error("Task is unavailable to this owner.");
    const task = taskSchema.parse(stored.document);
    if (task.revision !== revision) throw new Error("Task revision is stale.");

    return { task, leaseValid: stored.leaseValid };
  }

  function active(task: Task) {
    if (["succeeded", "failed", "canceled"].includes(task.state))
      throw new Error("Terminal tasks cannot be changed. Create new work explicitly.");
  }

  return {
    async runnable(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid runnable task page.");
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.tasks WHERE owner_id = ${ownerId}::uuid
          AND (document->>'state' = 'queued' OR (document->>'state' = 'running' AND leased_until <= clock_timestamp()))
        ORDER BY id LIMIT ${limit}
      `);
      return rows.rows.map((row) => taskSchema.parse(row.document));
    },
    async context(input: ActionTask) {
      const worker = actionTaskSchema.parse(input);
      const { task, leaseValid } = await current(worker.id, worker.revision);
      if (!leaseValid || task.state !== "running" || task.generation !== worker.generation)
        throw new Error("Worker lease is stale or expired.");
      const rows = await transaction.execute<{ envelope: unknown }>(sql`
        SELECT envelope FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid
          AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(task.sourceMessageIds)}::jsonb)::uuid)
        ORDER BY provider_sent_at, bot_id, chat_id, provider_message_id
      `);
      if (rows.rows.length !== task.sourceMessageIds.length)
        throw new Error("Task source messages unavailable.");
      const workspaces = await transaction.execute<{
        id: string;
        name: string;
        revision: number;
      }>(sql`
        SELECT w.id, w.name, w.revision FROM winston.workspaces w
        JOIN winston.workspace_runtimes r ON r.owner_id = w.owner_id AND r.workspace_id = w.id
        WHERE w.owner_id = ${ownerId}::uuid AND w.state = 'active' ORDER BY w.id LIMIT 100
      `);
      return {
        task,
        messages: rows.rows.map((row) => {
          const envelope = userMessageSchema.parse(row.envelope);
          return { id: envelope.messageId, content: serializeUserMessage(envelope) };
        }),
        resources: await taskResourceRepository(transaction, ownerId).list({
          id: task.id,
          revision: task.revision,
        }),
        workspaces: workspaces.rows,
      };
    },
    async yield(input: ActionTask) {
      const worker = actionTaskSchema.parse(input);
      const { task, leaseValid } = await current(worker.id, worker.revision);
      if (!leaseValid || task.state !== "running" || task.generation !== worker.generation)
        throw new Error("Worker lease is stale or expired.");
      return save({ ...task, state: "queued", revision: task.revision + 1 });
    },
    async find(id: string) {
      const stored = await row(id);

      return stored ? taskSchema.parse(stored.document) : undefined;
    },
    async listActive(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("Invalid task page size.");
      const result = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.tasks WHERE owner_id = ${ownerId}::uuid
          AND document->>'state' IN ('queued', 'running', 'waiting') ORDER BY id LIMIT ${limit}
      `);

      return result.rows.map((entry) => taskSchema.parse(entry.document));
    },
    async history(id: string, afterRevision = -1, limit = 100) {
      if (
        !Number.isInteger(afterRevision) ||
        afterRevision < -1 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new Error("Invalid task history page.");
      const result = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.task_revisions WHERE owner_id = ${ownerId}::uuid AND task_id = ${id}::uuid
          AND revision > ${afterRevision} ORDER BY revision LIMIT ${limit}
      `);

      return result.rows.map((entry) => taskSchema.parse(entry.document));
    },
    async create(input: TaskRequest) {
      await lockOwner();
      const request = taskRequestSchema.parse(input);
      request.sourceMessageIds = [...new Set(request.sourceMessageIds)].sort();
      const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const sources = await transaction.execute(sql`
        SELECT id FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid
          AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(request.sourceMessageIds)}::jsonb)::uuid)
      `);
      if (sources.rowCount !== request.sourceMessageIds.length)
        throw new Error("Task source messages are unavailable to this owner.");
      const task: Task = {
        id: randomUUID(),
        ownerId,
        objective: request.objective,
        sourceMessageIds: request.sourceMessageIds,
        revision: 0,
        generation: 0,
        state: "queued",
        blocker: null,
        result: null,
      };
      const inserted = await transaction.execute(sql`
        INSERT INTO winston.tasks (owner_id, id, request_key, request_hash, document)
        VALUES (${ownerId}::uuid, ${task.id}::uuid, ${request.key}, ${hash}, ${JSON.stringify(task)}::jsonb)
        ON CONFLICT (owner_id, request_key) DO NOTHING RETURNING id
      `);
      if (inserted.rowCount) {
        await record(task);
        return task;
      }
      const existing = await transaction.execute<TaskRow>(sql`
        SELECT document, request_hash AS "requestHash" FROM winston.tasks
        WHERE owner_id = ${ownerId}::uuid AND request_key = ${request.key}
      `);
      const previous = existing.rows[0];
      if (!previous || previous.requestHash !== hash)
        throw new Error("Task creation key conflicts with its original request.");

      return taskSchema.parse(previous.document);
    },
    async claim(id: string, revision: number) {
      const { task, leaseValid } = await current(id, revision);
      if (task.state !== "queued" && !(task.state === "running" && !leaseValid))
        throw new Error("Task cannot be claimed in its current state.");

      return save({
        ...task,
        state: "running",
        revision: task.revision + 1,
        generation: task.generation + 1,
      });
    },
    async heartbeat(id: string, revision: number, generation: number) {
      const { task, leaseValid } = await current(id, revision);
      if (task.state !== "running" || !leaseValid || task.generation !== generation) return false;
      await transaction.execute(sql`
        UPDATE winston.tasks SET leased_until = clock_timestamp() + interval '60 seconds'
        WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
      `);

      return true;
    },
    async finishStep(id: string, revision: number, generation: number, input: TaskOutcome) {
      const outcome = taskOutcomeSchema.parse(input);
      const { task, leaseValid } = await current(id, revision);
      if (task.state !== "running" || !leaseValid || task.generation !== generation)
        throw new Error("Worker lease is stale or expired.");

      return save({
        ...task,
        state: outcome.state,
        revision: task.revision + 1,
        blocker: outcome.state === "waiting" ? outcome.blocker : null,
        result: outcome.state === "waiting" ? null : outcome.result,
      });
    },
    async steer(id: string, revision: number, objective: string) {
      const { task } = await current(id, revision);
      active(task);
      await transaction.execute(
        sql`UPDATE winston.tasks SET intent_revision = intent_revision + 1 WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid`,
      );

      return save({
        ...task,
        objective: taskRequestSchema.shape.objective.parse(objective),
        state: "queued",
        revision: task.revision + 1,
        generation: task.generation + 1,
        blocker: null,
        result: null,
      });
    },
    async resume(id: string, revision: number, referenceId: string) {
      const { task } = await current(id, revision);
      if (task.state !== "waiting" || task.blocker?.referenceId !== referenceId)
        throw new Error("Task blocker is stale or unrelated.");

      return save({ ...task, state: "queued", revision: task.revision + 1, blocker: null });
    },
    async cancel(id: string, revision: number) {
      const { task } = await current(id, revision);
      if (task.state === "canceled") return task;
      active(task);

      return save({
        ...task,
        state: "canceled",
        revision: task.revision + 1,
        generation: task.generation + 1,
        blocker: null,
      });
    },
  };
}

export type TaskRepository = ReturnType<typeof taskRepository>;
