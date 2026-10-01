/**
 * Derived timers for `calendar.event.starting` (docs/design.md §3,
 * abstractions): the event fires `lead` minutes before a meeting starts and
 * follows moves and cancellations, so Winston never reschedules wake-ups
 * himself. Each subscription's timers are recomputed from the upcoming week
 * of events, so a moved meeting moves its timer and a cancelled one loses it.
 */
import type {
  CalendarEvent,
  CalendarProvider,
} from "@winston/connectors/calendar";
import { startInstant } from "@winston/connectors/google-calendar";
import type { DbOrTx } from "@winston/db/client";
import { refsFor, resolveRef } from "@winston/db/external-refs";
import { enqueue } from "@winston/db/queue";
import {
  connections,
  derivedTimers,
  events,
  triggers,
} from "@winston/db/schema";
import { parseEventPayload } from "@winston/domain/events";
import { refreshTimersJob } from "@winston/domain/jobs";
import { canFire } from "@winston/domain/triggers";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import { catalogEvent } from "../connections/sync-calendar.ts";
import type { JobHandler } from "../worker.ts";
import { addToBatch, passesFilter } from "./matching.ts";

/** How far ahead timers are kept. */
export const horizonMs = 7 * 24 * 3600_000;

const startingType = "calendar.event.starting";

type Connection = typeof connections.$inferSelect;
export type CalendarFor = (connection: Connection) => CalendarProvider;

/** The dedupe key of one meeting's heads-up for one subscription: fired once per start time. */
const firedKey = (triggerId: string, ref: string, start: Date) =>
  `cal-start:${triggerId}:${ref}:${start.toISOString()}`;

/** Upcoming events of an account, instances expanded, until `until`. */
async function upcoming(provider: CalendarProvider, now: Date, until: Date) {
  const found: CalendarEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await provider.list(
      { since: now, until },
      { limit: 100, ...(cursor ? { cursor } : {}) },
    );
    found.push(...page.items);
    cursor = page.cursor ?? undefined;
  } while (cursor && found.length < 1000);
  return found;
}

/**
 * Recomputes a subscription's timers: one per upcoming meeting that passes
 * its account, scope and filter, at start − lead (or now, for a meeting
 * already inside its lead that hasn't had its heads-up). Timers for meetings
 * no longer there, or no longer matching, go. A subscription that's no
 * longer active keeps none.
 */
export async function refreshTimers(
  db: DbOrTx,
  triggerId: string,
  calendarFor: CalendarFor,
  now = new Date(),
) {
  const [trigger] = await db
    .select()
    .from(triggers)
    .where(eq(triggers.id, triggerId));
  if (
    trigger?.status !== "active" ||
    trigger.eventType !== startingType ||
    trigger.leadMinutes === null
  ) {
    await db
      .delete(derivedTimers)
      .where(eq(derivedTimers.triggerId, triggerId));
    return 0;
  }
  const lead = trigger.leadMinutes * 60_000;
  const accounts = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.userId, trigger.userId),
        eq(connections.domain, "calendar"),
        inArray(connections.status, ["ok", "expiring"]),
        ...(trigger.connectionId
          ? [eq(connections.id, trigger.connectionId)]
          : []),
      ),
    );
  const wanted = new Map<string, Date>();
  for (const account of accounts) {
    const found = await upcoming(
      calendarFor(account),
      now,
      new Date(now.getTime() + horizonMs),
    );
    const ids = await refsFor(
      db,
      trigger.userId,
      account.id,
      "calendarEvent",
      found.map((e) => e.providerId),
    );
    for (const event of found) {
      if (event.status === "cancelled" || event.allDay) continue;
      const ref = ids.get(event.providerId) ?? "";
      if (trigger.scopeRef && trigger.scopeRef !== ref) continue;
      const payload = {
        event: catalogEvent(event, ref, account.externalEmail),
      };
      if (!passesFilter(payload, trigger.filter as Record<string, unknown>))
        continue;
      const start = startInstant(event);
      if (start <= now) continue;
      const due = new Date(start.getTime() - lead);
      if (due <= now) {
        // Inside its lead already: a heads-up now, unless it's had one.
        const [fired] = await db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.dedupeKey, firedKey(trigger.id, ref, start)));
        if (fired) continue;
      }
      wanted.set(ref, due <= now ? now : due);
    }
  }
  for (const [ref, fireAt] of wanted)
    await db
      .insert(derivedTimers)
      .values({ triggerId: trigger.id, ref, fireAt })
      .onConflictDoUpdate({
        target: [derivedTimers.triggerId, derivedTimers.ref],
        set: { fireAt },
      });
  const keep = [...wanted.keys()];
  await db
    .delete(derivedTimers)
    .where(
      and(
        eq(derivedTimers.triggerId, trigger.id),
        ...(keep.length > 0 ? [notInArray(derivedTimers.ref, keep)] : []),
      ),
    );
  return wanted.size;
}

/** Queues a timer refresh for each of a user's active `calendar.event.starting` subscriptions (or everyone's). */
export async function queueTimerRefreshes(db: DbOrTx, userId?: string) {
  const subscriptions = await db
    .select({ id: triggers.id, userId: triggers.userId })
    .from(triggers)
    .where(
      and(
        eq(triggers.status, "active"),
        eq(triggers.eventType, startingType),
        ...(userId ? [eq(triggers.userId, userId)] : []),
      ),
    );
  for (const trigger of subscriptions)
    await enqueue(db, refreshTimersJob.type, {
      userId: trigger.userId,
      payload: { triggerId: trigger.id },
      dedupeKey: refreshTimersJob.dedupeKey(trigger.id),
    });
  return subscriptions.length;
}

/**
 * Fires a due timer: the meeting as it is now becomes a
 * `calendar.event.starting` event for its subscription, stored once per start
 * time and added to that subscription's batch (so two meetings starting
 * together are one run). A meeting that's gone or moved isn't fired (the
 * next refresh puts its timer right). The timer is removed either way.
 */
export async function fireTimer(
  db: DbOrTx,
  timerId: number,
  calendarFor: CalendarFor,
  now = new Date(),
) {
  const [timer] = await db
    .select()
    .from(derivedTimers)
    .where(eq(derivedTimers.id, timerId));
  if (!timer) return undefined;
  const done = () =>
    db.delete(derivedTimers).where(eq(derivedTimers.id, timerId));
  const [trigger] = await db
    .select()
    .from(triggers)
    .where(eq(triggers.id, timer.triggerId));
  const ref = trigger
    ? await resolveRef(db, trigger.userId, timer.ref)
    : undefined;
  const [account] = ref
    ? await db
        .select()
        .from(connections)
        .where(eq(connections.id, ref.connectionId))
    : [];
  if (
    !trigger ||
    !ref ||
    !account ||
    trigger.leadMinutes === null ||
    !canFire(
      {
        kind: trigger.kind,
        status: trigger.status,
        at: trigger.at,
        cron: trigger.cron,
        maxFires: trigger.maxFires,
        fireCount: trigger.fireCount,
        expiresAt: trigger.expiresAt,
        onExpireNote: trigger.onExpireNote,
        nextFireAt: trigger.nextFireAt,
      },
      now,
    )
  ) {
    await done();
    return undefined;
  }
  let event: CalendarEvent;
  try {
    event = await calendarFor(account).get(ref.providerId);
  } catch {
    await done();
    return undefined;
  }
  const start = startInstant(event);
  const lead = trigger.leadMinutes * 60_000;
  // Cancelled, or moved so that its heads-up isn't due yet: leave it to the refresh.
  if (
    event.status === "cancelled" ||
    start <= now ||
    start.getTime() - lead > now.getTime() + 60_000
  ) {
    await done();
    if (event.status !== "cancelled" && start > now)
      await enqueue(db, refreshTimersJob.type, {
        userId: trigger.userId,
        payload: { triggerId: trigger.id },
        dedupeKey: refreshTimersJob.dedupeKey(trigger.id),
      });
    return undefined;
  }
  const payload = parseEventPayload(startingType, {
    event: catalogEvent(event, timer.ref, account.externalEmail),
    leadMinutes: trigger.leadMinutes,
  });
  const [stored] = await db
    .insert(events)
    .values({
      userId: trigger.userId,
      connectionId: account.id,
      type: startingType,
      payload,
      occurredAt: now,
      dedupeKey: firedKey(trigger.id, timer.ref, start),
    })
    .onConflictDoNothing({ target: events.dedupeKey })
    .returning({ id: events.id });
  if (stored) await addToBatch(db, trigger, stored.id);
  await done();
  return stored?.id;
}

/** `refresh_timers`: recomputes one subscription's timers. */
export function refreshTimersHandler(calendarFor: CalendarFor): JobHandler {
  return async ({ job, db, logger }) => {
    const { triggerId } = z
      .object({ triggerId: z.string() })
      .parse(job.payload);
    const count = await refreshTimers(db, triggerId, calendarFor);
    logger.info({ triggerId, timers: count }, "timers refreshed");
  };
}

/** `fire_derived_timer`: fires one due timer. */
export function fireDerivedTimerHandler(calendarFor: CalendarFor): JobHandler {
  return async ({ job, db, logger }) => {
    const { timerId } = z.object({ timerId: z.number() }).parse(job.payload);
    const eventId = await fireTimer(db, timerId, calendarFor);
    logger.info(
      { timerId, eventId },
      eventId ? "meeting heads-up queued" : "timer had nothing to fire",
    );
  };
}
