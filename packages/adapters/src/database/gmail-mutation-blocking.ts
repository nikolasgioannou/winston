import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "./owners";

export class GmailMutationBlockedError extends Error {
  constructor(readonly actionId: string) {
    super("An earlier Gmail mutation remains unresolved.");
  }
}

// Called under the owner lock; the outer workspace CLI command is not a Gmail effect.
export async function assertGmailMutationResolved(
  transaction: DatabaseTransaction,
  ownerId: string,
  taskId: string,
  excludeId: string | null = null,
) {
  const rows = await transaction.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM winston.actions
    WHERE owner_id = ${ownerId}::uuid AND task_id = ${taskId}::uuid
      AND document->'request'->'authorization'->>'operation' IN ('gmail.draft', 'gmail.send', 'gmail.modify')
      AND document->>'state' IN ('dispatching', 'unknown')
      AND (${excludeId}::uuid IS NULL OR id <> ${excludeId}::uuid)
    ORDER BY id LIMIT 1
  `);
  const prior = rows.rows[0];
  if (prior) throw new GmailMutationBlockedError(prior.id);
}
