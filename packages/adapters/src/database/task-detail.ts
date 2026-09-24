import { sql } from "drizzle-orm";
import {
  taskSchema,
  taskDetailSchema,
  taskHistorySchema,
  taskHistoryCursorSchema,
} from "@winston/contracts/tasks";
import type { DatabaseTransaction } from "./owners";

type RevisionRow = { document: unknown; createdAt: string; updatedAt: string };

function publicRevision(row: RevisionRow) {
  const task = taskSchema.parse(row.document);
  return {
    id: task.id,
    revision: task.revision,
    state: task.state,
    objective: task.objective,
    result: task.result,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    waiting:
      task.state === "waiting" && task.blocker
        ? { kind: task.blocker.kind, detail: task.blocker.detail }
        : null,
  };
}

export async function taskDetail(
  transaction: DatabaseTransaction,
  ownerId: string,
  inputId: string,
) {
  const id = taskSchema.shape.id.parse(inputId);
  const rows = await transaction.execute<RevisionRow>(sql`
    SELECT t.document,
      to_char(origin.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
      to_char(latest.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
    FROM winston.tasks t
    JOIN winston.task_revisions origin ON origin.owner_id = t.owner_id AND origin.task_id = t.id AND origin.revision = 0
    JOIN winston.task_revisions latest ON latest.owner_id = t.owner_id AND latest.task_id = t.id
      AND latest.revision = (t.document->>'revision')::integer
    WHERE t.owner_id = ${ownerId}::uuid AND t.id = ${id}::uuid
  `);
  const row = rows.rows[0];
  return row ? taskDetailSchema.parse(publicRevision(row)) : null;
}

export async function taskHistory(
  transaction: DatabaseTransaction,
  ownerId: string,
  inputId: string,
  before?: number,
) {
  const id = taskSchema.shape.id.parse(inputId);
  if (before !== undefined) taskHistoryCursorSchema.parse(before);
  const rows = await transaction.execute<RevisionRow>(sql`
    SELECT history.document,
      to_char(origin.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
      to_char(history.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
    FROM winston.task_revisions history
    JOIN winston.task_revisions origin ON origin.owner_id = history.owner_id AND origin.task_id = history.task_id AND origin.revision = 0
    WHERE history.owner_id = ${ownerId}::uuid AND history.task_id = ${id}::uuid
      ${before === undefined ? sql`` : sql`AND history.revision < ${before}`}
    ORDER BY history.revision DESC LIMIT 21
  `);
  const items = rows.rows.slice(0, 20).map((row) => {
    const value = publicRevision(row);
    return {
      ...value,
      objective: value.objective.slice(0, 2000),
      objectiveTruncated: value.objective.length > 2000,
      result: value.result?.slice(0, 4000) ?? null,
      resultTruncated: (value.result?.length ?? 0) > 4000,
    };
  });
  return taskHistorySchema.parse({
    items,
    next: rows.rows.length > 20 ? items.at(-1)?.revision : null,
  });
}
