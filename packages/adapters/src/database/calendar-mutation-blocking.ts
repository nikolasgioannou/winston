import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "./owners";

export class CalendarMutationBlockedError extends Error {
  constructor(readonly actionId: string) {
    super("An earlier Calendar mutation remains unresolved.");
  }
}

// Call under the owner lock. Do not count the outer workspace command running the CLI.
export async function assertCalendarMutationResolved(
  transaction: DatabaseTransaction,
  ownerId: string,
  taskId: string,
  excludeId: string | null = null,
) {
  const rows = await transaction.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM winston.actions
    WHERE owner_id = ${ownerId}::uuid AND task_id = ${taskId}::uuid
      AND document->'request'->'authorization'->>'operation' = 'calendar.write'
      AND document->>'state' IN ('dispatching', 'unknown')
      AND (${excludeId}::uuid IS NULL OR id <> ${excludeId}::uuid)
    ORDER BY id LIMIT 1
  `);
  const prior = rows.rows[0];
  if (prior) throw new CalendarMutationBlockedError(prior.id);
}
