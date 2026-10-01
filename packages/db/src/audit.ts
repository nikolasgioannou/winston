import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { auditLog } from "./schema/index.ts";

/** Fields whose text is content, not a description of the action. */
const contentFields = new Set(["body", "html", "description", "note", "text"]);

/**
 * A request as the audit log keeps it (docs/design.md §5): every field,
 * except that message bodies and other free text become their length, so the
 * log says what was done without holding what was written.
 */
export function redactRequest(
  request: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(request).map(([key, value]) => [
      key,
      contentFields.has(key) && typeof value === "string"
        ? `[${String(value.length)} characters]`
        : value,
    ]),
  );
}

export interface AuditEntry {
  userId: string;
  runId: string | null;
  connectionId: string;
  action: string;
  targetRef?: string | undefined;
  summary: string;
  request: Record<string, unknown>;
}

/**
 * Records a write around the provider call (docs/design.md §5, §14): the row
 * is written as `pending` before `call` runs, then marked `ok` (with the id of
 * what was created or changed) or `error`. The provider is never called
 * without its row, and a failed call stays on record.
 */
export async function audited<T>(
  db: DbOrTx,
  entry: AuditEntry,
  call: () => Promise<T>,
  resultRef?: (result: T) => string | undefined,
): Promise<T> {
  const [row] = await db
    .insert(auditLog)
    .values({ ...entry, request: redactRequest(entry.request) })
    .returning({ id: auditLog.id });
  if (!row) throw new Error("The audit row wasn't written.");
  try {
    const result = await call();
    await db
      .update(auditLog)
      .set({
        outcome: "ok",
        resultRef: resultRef?.(result) ?? null,
        finishedAt: sql`now()`,
      })
      .where(eq(auditLog.id, row.id));
    return result;
  } catch (error) {
    await db
      .update(auditLog)
      .set({
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: sql`now()`,
      })
      .where(eq(auditLog.id, row.id));
    throw error;
  }
}
