import { sql } from "drizzle-orm";
import { actionRecordSchema } from "@winston/contracts/actions";
import { taskActionEvidenceSchema, taskSchema } from "@winston/contracts/tasks";
import type { DatabaseTransaction } from "./owners";

export async function taskActionEvidence(
  transaction: DatabaseTransaction,
  ownerId: string,
  inputId: string,
  inputAfter?: string,
) {
  const id = taskSchema.shape.id.parse(inputId);
  const after = inputAfter === undefined ? undefined : taskSchema.shape.id.parse(inputAfter);
  const counts = await transaction.execute<{ unresolved: number }>(sql`
    SELECT count(*)::int AS unresolved FROM winston.actions
    WHERE owner_id = ${ownerId}::uuid AND task_id = ${id}::uuid
      AND document->>'state' IN ('dispatching', 'unknown')
  `);
  const rows = await transaction.execute<{ document: unknown }>(sql`
    SELECT document FROM winston.actions
    WHERE owner_id = ${ownerId}::uuid AND task_id = ${id}::uuid
      ${after ? sql`AND id > ${after}::uuid` : sql``}
    ORDER BY id LIMIT 21
  `);
  const items = rows.rows.slice(0, 20).map((row) => {
    const action = actionRecordSchema.parse(row.document);
    return {
      id: action.id,
      intentRevision: action.intentRevision,
      authorization: action.request.authorization,
      state: action.state,
      decisionSource: action.decisionSource,
      expiresAt: action.expiresAt,
    };
  });
  return taskActionEvidenceSchema.parse({
    unresolved: counts.rows[0]?.unresolved ?? 0,
    items,
    next: rows.rows.length > 20 ? items.at(-1)?.id : null,
  });
}
