import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { newId } from "./ids.ts";
import { externalRefs } from "./schema/index.ts";

export type ExternalRefKind = (typeof externalRefs.$inferSelect)["kind"];

export interface ExternalRef {
  id: string;
  userId: string;
  connectionId: string;
  kind: ExternalRefKind;
  providerId: string;
}

/**
 * CLI ids for provider objects (docs/design.md §11): returns each object's
 * id, creating the ones it hasn't been given yet. The same object always
 * gets the same id.
 */
export async function refsFor(
  db: DbOrTx,
  userId: string,
  connectionId: string,
  kind: ExternalRefKind,
  providerIds: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(providerIds)];
  if (wanted.length === 0) return new Map();
  await db
    .insert(externalRefs)
    .values(
      wanted.map((providerId) => ({
        id: newId(kind),
        userId,
        connectionId,
        kind,
        providerId,
      })),
    )
    .onConflictDoNothing({
      target: [
        externalRefs.connectionId,
        externalRefs.kind,
        externalRefs.providerId,
      ],
    });
  const rows = await db
    .select({ id: externalRefs.id, providerId: externalRefs.providerId })
    .from(externalRefs)
    .where(
      and(
        eq(externalRefs.connectionId, connectionId),
        eq(externalRefs.kind, kind),
        inArray(externalRefs.providerId, wanted),
      ),
    );
  return new Map(rows.map((row) => [row.providerId, row.id]));
}

/** One object's CLI id. */
export async function refFor(
  db: DbOrTx,
  userId: string,
  connectionId: string,
  kind: ExternalRefKind,
  providerId: string,
): Promise<string> {
  const id = (await refsFor(db, userId, connectionId, kind, [providerId])).get(
    providerId,
  );
  if (!id) throw new Error(`No id for ${kind} ${providerId}.`);
  return id;
}

/** What a CLI id stands for, if it's this user's. */
export async function resolveRef(
  db: DbOrTx,
  userId: string,
  id: string,
): Promise<ExternalRef | undefined> {
  const [row] = await db
    .select()
    .from(externalRefs)
    .where(and(eq(externalRefs.id, id), eq(externalRefs.userId, userId)));
  return row
    ? {
        id: row.id,
        userId: row.userId,
        connectionId: row.connectionId,
        kind: row.kind,
        providerId: row.providerId,
      }
    : undefined;
}
