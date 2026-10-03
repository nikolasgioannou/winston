/**
 * Trigger runs (docs/design.md §3, Handling): every firing (a schedule, a
 * batch of events, an expiry, a derived timer) starts the same kind of
 * background run as a delegated task, with the trigger's note to its future
 * self, the events, and a read-only tail of the conversation.
 */
import type { DbOrTx } from "@winston/db/client";
import {
  inboundItems,
  outboundMessages,
  triggers,
  users,
} from "@winston/db/schema";
import {
  renderBatch,
  renderEvent,
  type EventItem,
} from "@winston/domain/envelope";
import {
  afterFire,
  canFire,
  expire,
  type TriggerLifecycle,
} from "@winston/domain/triggers";
import { formatEnvelopeTime } from "@winston/shared/time";
import { and, desc, eq, sql } from "drizzle-orm";
import { toEnvelopeItems } from "@winston/db/envelopes";
import { startBackgroundRun } from "./run.ts";

/** How many recent messages the read-only tail holds (§16). */
export const tailItems = 20;

/** Ends the first message: notes before acting (§2, remembering to look). */
export const notesReminder =
  "Before acting on this, check your notes for anything relevant (`~/notes/preferences.md`, and `rg -i` for the people or topics involved).";

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The last messages between the user and Winston, oldest first, rendered as
 * they would be in the conversation: the user's as `user_message` envelopes,
 * Winston's as `<winston_message>`. It's context, never instructions to act on.
 */
export async function conversationTail(
  db: DbOrTx,
  userId: string,
  timeZone: string,
) {
  const received = await db
    .select()
    .from(inboundItems)
    .where(
      and(
        eq(inboundItems.userId, userId),
        eq(inboundItems.type, "user_message"),
      ),
    )
    .orderBy(desc(inboundItems.occurredAt))
    .limit(tailItems);
  const sent = await db
    .select({ text: outboundMessages.text, sentAt: outboundMessages.sentAt })
    .from(outboundMessages)
    .where(eq(outboundMessages.userId, userId))
    .orderBy(desc(outboundMessages.sentAt))
    .limit(tailItems);
  const theirs = await toEnvelopeItems(db, userId, received);
  const items = [
    ...theirs.map((item) => ({
      at: item.occurredAt,
      xml: renderBatch([item], timeZone),
    })),
    ...sent.map((message) => ({
      at: message.sentAt,
      xml: `<winston_message sent_at="${formatEnvelopeTime(message.sentAt, timeZone)}">${escape(message.text)}</winston_message>`,
    })),
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-tailItems);
  return items.length === 0
    ? "<conversation_tail/>"
    : `<conversation_tail>\n${items.map((item) => item.xml).join("\n")}\n</conversation_tail>`;
}

type TriggerRow = typeof triggers.$inferSelect;

const lifecycle = (row: TriggerRow): TriggerLifecycle => ({
  kind: row.kind,
  status: row.status,
  at: row.at,
  cron: row.cron,
  maxFires: row.maxFires,
  fireCount: row.fireCount,
  expiresAt: row.expiresAt,
  onExpireNote: row.onExpireNote,
  nextFireAt: row.nextFireAt,
});

/**
 * Fires a trigger: counts the fire and applies the lifecycle (or expires it),
 * and starts its run, in one transaction with the trigger's row locked, so a
 * crash or a second worker can't double-fire it or lose a fire. Returns the
 * run's id, or undefined if the trigger can't fire (exhausted, expired,
 * deleted meanwhile, or an expiry with no `on_expire` run due).
 */
export async function startTriggerRun(
  db: DbOrTx,
  options: {
    triggerId: string;
    reason: "schedule" | "event" | "expire";
    /** The events that fired it, for event runs. */
    events?: EventItem[];
    /** For a schedule: the occurrence being fired; nothing happens if the trigger has moved past it. */
    occurrence?: Date;
    now?: Date;
  },
) {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(triggers)
      .where(eq(triggers.id, options.triggerId))
      .for("update");
    if (!row) return undefined;
    const [user] = await tx
      .select({ timeZone: users.timezone })
      .from(users)
      .where(eq(users.id, row.userId));
    const timeZone = user?.timeZone ?? "UTC";
    const state = lifecycle(row);

    let note: string;
    if (options.reason === "expire") {
      const expiry = expire(state, now);
      if (!expiry) return undefined;
      await tx
        .update(triggers)
        .set({ status: expiry.status, nextFireAt: null, updatedAt: sql`now()` })
        .where(eq(triggers.id, row.id));
      if (!expiry.runOnExpire || !row.onExpireNote) return undefined;
      note = row.onExpireNote;
    } else {
      if (!canFire(state, now)) return undefined;
      if (
        options.occurrence &&
        row.nextFireAt?.getTime() !== options.occurrence.getTime()
      )
        return undefined;
      const fired = afterFire(state, now, timeZone);
      await tx
        .update(triggers)
        .set({ ...fired, updatedAt: sql`now()` })
        .where(eq(triggers.id, row.id));
      note = row.note;
    }

    const tail = await conversationTail(tx, row.userId, timeZone);
    const events = (options.events ?? [])
      .map((event) => renderEvent(event, timeZone))
      .join("\n\n");
    const why = {
      schedule: "its scheduled time came",
      event: "events it subscribes to arrived",
      expire: "it expired before it fired",
    }[options.reason];
    return startBackgroundRun(tx, {
      userId: row.userId,
      brief: note,
      // Most trigger runs end with a quick look; a run raises its effort if needed (§6).
      effort: "low",
      triggerType: options.reason,
      triggerId: row.id,
      message: (startedAt) =>
        [
          `<trigger id="${row.id}" kind="${row.kind}" fired_at="${startedAt}" reason="${why}">`,
          `<note>${escape(note)}</note>`,
          "</trigger>",
          ...(events ? ["", events] : []),
          "",
          tail,
          "",
          notesReminder,
        ].join("\n"),
    });
  });
}
