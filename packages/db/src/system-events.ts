import { frontTurnJob } from "@winston/domain/jobs";
import type { DbOrTx } from "./client.ts";
import { enqueue } from "./queue.ts";
import { inboundItems } from "./schema/index.ts";

/**
 * Tells Winston about something that happened outside Telegram, such as an
 * account being connected on the site: an inbound item plus the user's
 * debounced front-of-house turn, together (docs/design.md §4). A repeated
 * `sourceRef` is ignored. Returns whether it was recorded.
 */
export async function recordSystemEvent(
  db: DbOrTx,
  event: { userId: string; type: string; payload: unknown; sourceRef: string },
) {
  return db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(inboundItems)
      .values({ ...event, occurredAt: new Date() })
      .onConflictDoNothing({ target: inboundItems.sourceRef })
      .returning({ id: inboundItems.id });
    if (!stored) return false;
    await enqueue(tx, frontTurnJob.type, {
      userId: event.userId,
      dedupeKey: frontTurnJob.dedupeKey(event.userId),
      delayMs: frontTurnJob.debounceMs,
      onDuplicate: "reschedule",
    });
    return true;
  });
}
