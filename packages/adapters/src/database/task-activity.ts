import { sql } from "drizzle-orm";
import {
  taskActivitySchema,
  taskActivityCursorSchema,
  taskSchema,
  type TaskActivityCursor,
} from "@winston/contracts/tasks";
import type { DatabaseTransaction } from "./owners";

export async function taskActivity(
  transaction: DatabaseTransaction,
  ownerId: string,
  before?: TaskActivityCursor,
) {
  if (before) taskActivityCursorSchema.parse(before);
  const rows = await transaction.execute<{
    document: unknown;
    createdAt: string;
    updatedAt: string;
  }>(sql`
    SELECT t.document,
      to_char(origin.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
      to_char(latest.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
    FROM winston.task_revisions origin
    JOIN winston.tasks t ON t.owner_id = origin.owner_id AND t.id = origin.task_id
    JOIN winston.task_revisions latest ON latest.owner_id = t.owner_id AND latest.task_id = t.id
      AND latest.revision = (t.document->>'revision')::integer
    WHERE origin.owner_id = ${ownerId}::uuid AND origin.revision = 0
      ${before ? sql`AND (origin.created_at, origin.task_id) < (${before.createdAt}::timestamptz, ${before.id}::uuid)` : sql``}
    ORDER BY origin.created_at DESC, origin.task_id DESC LIMIT 21
  `);
  const items = rows.rows.slice(0, 20).map((row) => {
    const task = taskSchema.parse(row.document);
    return {
      id: task.id,
      revision: task.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      objective: task.objective.slice(0, 2000),
      objectiveTruncated: task.objective.length > 2000,
      state: task.state,
      waiting:
        task.state === "waiting" && task.blocker
          ? { kind: task.blocker.kind, detail: task.blocker.detail }
          : null,
      result: task.result?.slice(0, 4000) ?? null,
      resultTruncated: (task.result?.length ?? 0) > 4000,
    };
  });
  const last = items.at(-1);
  return taskActivitySchema.parse({
    items,
    next: rows.rows.length > 20 && last ? { createdAt: last.createdAt, id: last.id } : null,
  });
}
