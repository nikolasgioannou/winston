import { sql } from "drizzle-orm";
import {
  taskChangedSchema,
  taskUpdateIdsSchema,
  taskUpdateSchema,
} from "@winston/contracts/task-updates";
import { taskSchema } from "@winston/contracts/tasks";
import type { DatabaseTransaction } from "./owners";
import { eventRepository } from "./events";

export function taskUpdateRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }

  async function pending() {
    const rows = await transaction.execute<{ document: unknown }>(sql`
      SELECT u.document FROM winston.task_updates u
      JOIN winston.tasks t ON t.owner_id = u.owner_id AND t.id = u.task_id
      LEFT JOIN winston.telegram_outbound o ON o.owner_id = u.owner_id AND o.id = u.response_id
      WHERE u.owner_id = ${ownerId}::uuid AND (u.response_id IS NULL OR o.state = 'canceled')
        AND (t.document->>'revision')::integer = u.task_revision
      ORDER BY u.created_at, u.event_id LIMIT 20
    `);
    return rows.rows.map((row) => taskUpdateSchema.parse(row.document));
  }

  return {
    async consume(eventId: string) {
      await lock();
      return eventRepository(transaction, ownerId).consume(
        eventId,
        "conversation-updates",
        async (event) => {
          // These changes are already durable and read by subsequent turns.
          // Their connection-runtime destination is independent of this receipt.
          if (["connection.connected", "connection.health", "memory.changed"].includes(event.type))
            return;
          if (event.type !== "task.changed") throw new Error("Unsupported task update event.");
          const update = taskChangedSchema.parse(event.payload);
          if (update.state !== "succeeded" && update.state !== "failed") return;
          const rows = await transaction.execute<{ document: unknown }>(sql`
            SELECT document FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${update.taskId}::uuid
          `);
          if (!rows.rows[0]) return;
          const task = taskSchema.parse(rows.rows[0].document);
          if (
            task.revision !== update.revision ||
            task.state !== update.state ||
            !task.sourceMessageIds.length
          )
            return;
          const document = taskUpdateSchema.parse({
            id: event.id,
            taskId: task.id,
            revision: task.revision,
            state: task.state,
            objectivePreview: task.objective.slice(0, 500),
            resultPreview: (task.result ?? "").slice(0, 8000),
            resultTruncated: (task.result?.length ?? 0) > 8000,
          });
          await transaction.execute(sql`
            INSERT INTO winston.task_updates (owner_id, event_id, task_id, task_revision, document)
            VALUES (${ownerId}::uuid, ${event.id}, ${task.id}::uuid, ${task.revision}, ${JSON.stringify(document)}::jsonb)
            ON CONFLICT DO NOTHING
          `);
        },
      );
    },
    async pending() {
      await lock();
      return pending();
    },
    async link(inputIds: string[], inputResponseId: string) {
      const ids = [...new Set(taskUpdateIdsSchema.parse(inputIds))];
      const responseId = taskSchema.shape.id.parse(inputResponseId);
      await lock();
      const available = await pending();
      if (!ids.every((id) => available.some((update) => update.id === id)))
        throw new Error("Task update changed or already presented.");
      const response = await transaction.execute(sql`
        SELECT id FROM winston.telegram_outbound WHERE owner_id = ${ownerId}::uuid AND id = ${responseId}::uuid AND state = 'pending'
      `);
      if (!response.rowCount) throw new Error("Presentation response unavailable.");
      await transaction.execute(sql`
        UPDATE winston.task_updates SET response_id = ${responseId}::uuid
        WHERE owner_id = ${ownerId}::uuid AND event_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
      `);
    },
    async forResponse(inputId: string) {
      const responseId = taskSchema.shape.id.parse(inputId);
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.task_updates WHERE owner_id = ${ownerId}::uuid AND response_id = ${responseId}::uuid
        ORDER BY created_at, event_id LIMIT 20
      `);
      return rows.rows.map((row) => taskUpdateSchema.parse(row.document));
    },
  };
}
