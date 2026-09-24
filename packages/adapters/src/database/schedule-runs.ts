import { sql } from "drizzle-orm";
import { taskSchema } from "@winston/contracts/tasks";
import {
  scheduleRunCursorSchema,
  scheduleRunsSchema,
  type ScheduleRunCursor,
} from "@winston/contracts/schedules";
import type { DatabaseTransaction } from "./owners";

export async function scheduleRuns(
  transaction: DatabaseTransaction,
  ownerId: string,
  id: string,
  before?: ScheduleRunCursor,
) {
  if (before) scheduleRunCursorSchema.parse(before);
  const rows = await transaction.execute<{
    revision: number;
    dueAt: string;
    document: unknown;
  }>(sql`
    SELECT o.revision, o.due_at AS "dueAt", t.document
    FROM winston.schedule_occurrences o
    JOIN winston.tasks t ON t.owner_id = o.owner_id AND t.id = o.task_id
    WHERE o.owner_id = ${ownerId}::uuid AND o.schedule_id = ${id}::uuid
      ${before ? sql`AND (o.revision, o.due_at) < (${before.revision}, ${before.dueAt}::timestamptz)` : sql``}
    ORDER BY o.revision DESC, o.due_at DESC LIMIT 21
  `);
  const items = rows.rows.slice(0, 20).map((row) => {
    const task = taskSchema.parse(row.document);
    return {
      scheduleRevision: row.revision,
      dueAt: new Date(row.dueAt).toISOString(),
      taskId: task.id,
      state: task.state,
      waiting:
        task.state === "waiting" && task.blocker
          ? { kind: task.blocker.kind, detail: task.blocker.detail }
          : null,
      result: task.result?.slice(0, 4000) ?? null,
      truncated: (task.result?.length ?? 0) > 4000,
    };
  });
  const last = items.at(-1);
  return scheduleRunsSchema.parse({
    items,
    next:
      rows.rows.length > 20 && last ? { revision: last.scheduleRevision, dueAt: last.dueAt } : null,
  });
}
