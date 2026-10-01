/**
 * The reconciliation backstop (docs/design.md §3): push notifications
 * occasionally get lost, so every 10 minutes each healthy connection gets a
 * sync anyway, and watches that are missing or about to lapse are renewed.
 * A sync that finds nothing is harmless: checkpoints live in Postgres and
 * events have dedupe keys.
 */
import type { DbOrTx } from "@winston/db/client";
import { enqueue } from "@winston/db/queue";
import { connections } from "@winston/db/schema";
import { syncConnectionJob } from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { inArray } from "drizzle-orm";
import { renewWatches } from "./watch.ts";

/** How often every connection is reconciled. */
export const reconcileEveryMs = 10 * 60_000;

/**
 * Where in the interval a connection's sync lands: the same offset every
 * time, spread by its id, so connections don't all sync at once.
 */
export function offsetOf(connectionId: string) {
  const hash = new Bun.CryptoHasher("sha256").update(connectionId).digest();
  return hash.readUInt32BE(0) % reconcileEveryMs;
}

/**
 * Queues a sync for every healthy connection, each at its offset, and
 * renews watches. A sync already queued (say, from a push) is left as it
 * is, so this never delays one. Returns how many connections it covered.
 */
export async function reconcileConnections(db: DbOrTx, now = new Date()) {
  const healthy = await db
    .select({ id: connections.id, userId: connections.userId })
    .from(connections)
    .where(inArray(connections.status, ["ok", "expiring"]));
  for (const connection of healthy)
    await enqueue(db, syncConnectionJob.type, {
      userId: connection.userId,
      payload: { connectionId: connection.id },
      dedupeKey: syncConnectionJob.dedupeKey(connection.id),
      delayMs: offsetOf(connection.id),
    });
  await renewWatches(db, now);
  return healthy.length;
}

/** Reconciles now and then every 10 minutes. */
export function startReconciliation(db: DbOrTx, logger: Logger) {
  const sweep = () => {
    reconcileConnections(db).catch((error: unknown) => {
      logger.error({ err: error }, "reconciling connections failed");
    });
  };
  const timer = setInterval(sweep, reconcileEveryMs);
  sweep();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
