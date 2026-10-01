import { describe, expect, test } from "bun:test";
import type {
  CalendarEvent,
  CalendarProvider,
} from "@winston/connectors/calendar";
import type { DbOrTx } from "@winston/db/client";
import { refFor } from "@winston/db/external-refs";
import {
  derivedTimers,
  events,
  jobs,
  triggerBatches,
  triggers,
} from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { eq } from "drizzle-orm";
import { fireTimer, horizonMs, refreshTimers } from "./timers.ts";

const db = await testDb();
const now = new Date("2026-10-05T12:00:00Z");
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

const meeting = (
  id: string,
  startsIn: number,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent => ({
  providerId: `me@example.com/${id}`,
  calendarId: "me@example.com",
  title: `Meeting ${id}`,
  start: { at: minutes(startsIn) },
  end: { at: minutes(startsIn + 30) },
  allDay: false,
  location: null,
  description: null,
  organizer: { email: "me@example.com", name: null, self: true },
  attendees: [
    {
      email: "me@example.com",
      name: null,
      response: "accepted",
      optional: false,
      self: true,
    },
    {
      email: "sam@other.com",
      name: "Sam",
      response: "accepted",
      optional: false,
      self: false,
    },
  ],
  myResponse: "accepted",
  status: "confirmed",
  videoLink: null,
  recurrence: null,
  seriesId: null,
  htmlLink: null,
  updatedAt: null,
  ...overrides,
});

/** A calendar holding `meetings`, answering lists by time range and gets by id. */
function calendarOf(meetings: CalendarEvent[]): CalendarProvider {
  return {
    list: (filter: { since: Date; until: Date }) =>
      Promise.resolve({
        items: meetings.filter((m) => {
          const at = "at" in m.start ? m.start.at : now;
          return at >= filter.since && at < filter.until;
        }),
        cursor: null,
      }),
    get: (id: string) => {
      const found = meetings.find((m) => m.providerId === id);
      return found ? Promise.resolve(found) : Promise.reject(new Error("gone"));
    },
  } as unknown as CalendarProvider;
}

async function setup(
  tx: DbOrTx,
  values: Partial<typeof triggers.$inferInsert> = {},
) {
  const user = await insertUser(tx);
  const account = await insertConnection(tx, user.id, {
    domain: "calendar",
    externalEmail: "me@example.com",
  });
  const [trigger] = await tx
    .insert(triggers)
    .values({
      userId: user.id,
      kind: "subscription",
      eventType: "calendar.event.starting",
      leadMinutes: 15,
      note: "Brief Nik on who's coming.",
      ...values,
    })
    .returning();
  if (!trigger) throw new Error("no trigger");
  return { user, account, trigger };
}

const timersOf = async (tx: DbOrTx, triggerId: string) =>
  (
    await tx
      .select()
      .from(derivedTimers)
      .where(eq(derivedTimers.triggerId, triggerId))
  )
    .map((t): string[] => [t.ref, t.fireAt.toISOString()])
    .sort();

describe("meeting heads-up timers", () => {
  test("a timer per matching meeting in the week ahead, at start − lead; one inside its lead fires now", async () => {
    await inRollback(db, async (tx) => {
      const { user, account, trigger } = await setup(tx, {
        filter: { external: true },
      });
      const calendar = calendarOf([
        meeting("a", 60),
        meeting("solo", 90, { attendees: [] }),
        meeting("soon", 5),
        meeting("later", 8 * 24 * 60),
      ]);
      expect(await refreshTimers(tx, trigger.id, () => calendar, now)).toBe(2);
      const a = await refFor(
        tx,
        user.id,
        account.id,
        "calendarEvent",
        "me@example.com/a",
      );
      const soon = await refFor(
        tx,
        user.id,
        account.id,
        "calendarEvent",
        "me@example.com/soon",
      );
      expect(await timersOf(tx, trigger.id)).toEqual(
        [
          [a, minutes(45).toISOString()],
          [soon, now.toISOString()],
        ].sort(),
      );
      // A week on, the later meeting comes into the horizon.
      const later = new Date(now.getTime() + horizonMs - 60 * 60_000);
      await refreshTimers(tx, trigger.id, () => calendar, later);
      expect((await timersOf(tx, trigger.id)).length).toBe(1);
    });
  });

  test("a moved meeting moves its timer; a cancelled one loses it; a deleted subscription keeps none", async () => {
    await inRollback(db, async (tx) => {
      const { trigger } = await setup(tx);
      await refreshTimers(
        tx,
        trigger.id,
        () => calendarOf([meeting("a", 60), meeting("b", 120)]),
        now,
      );
      await refreshTimers(
        tx,
        trigger.id,
        () => calendarOf([meeting("a", 180)]),
        now,
      );
      const timers = await timersOf(tx, trigger.id);
      expect(timers).toHaveLength(1);
      expect(timers[0]?.[1]).toBe(minutes(165).toISOString());
      await tx
        .update(triggers)
        .set({ status: "deleted" })
        .where(eq(triggers.id, trigger.id));
      await refreshTimers(
        tx,
        trigger.id,
        () => calendarOf([meeting("a", 180)]),
        now,
      );
      expect(await timersOf(tx, trigger.id)).toEqual([]);
    });
  });

  test("firing makes one calendar.event.starting event for the subscription's batch, and never twice for one start", async () => {
    await inRollback(db, async (tx) => {
      const { trigger } = await setup(tx);
      const calendar = calendarOf([meeting("a", 10)]);
      await refreshTimers(tx, trigger.id, () => calendar, now);
      const [timer] = await tx
        .select()
        .from(derivedTimers)
        .where(eq(derivedTimers.triggerId, trigger.id));
      const eventId = await fireTimer(tx, timer?.id ?? 0, () => calendar, now);
      const [stored] = await tx
        .select()
        .from(events)
        .where(eq(events.id, eventId ?? ""));
      expect(stored?.type).toBe("calendar.event.starting");
      expect(stored?.payload).toMatchObject({
        leadMinutes: 15,
        event: { title: "Meeting a" },
      });
      expect(
        (
          await tx
            .select()
            .from(triggerBatches)
            .where(eq(triggerBatches.triggerId, trigger.id))
        )[0]?.eventIds,
      ).toEqual([eventId ?? ""]);
      expect(await timersOf(tx, trigger.id)).toEqual([]);
      // A refresh doesn't bring back a heads-up that already went out.
      await refreshTimers(tx, trigger.id, () => calendar, now);
      expect(await timersOf(tx, trigger.id)).toEqual([]);
    });
  });

  test("a meeting moved later isn't fired early; the refresh puts its timer right", async () => {
    await inRollback(db, async (tx) => {
      const { trigger } = await setup(tx);
      await refreshTimers(
        tx,
        trigger.id,
        () => calendarOf([meeting("a", 10)]),
        now,
      );
      const [timer] = await tx
        .select()
        .from(derivedTimers)
        .where(eq(derivedTimers.triggerId, trigger.id));
      expect(
        await fireTimer(
          tx,
          timer?.id ?? 0,
          () => calendarOf([meeting("a", 120)]),
          now,
        ),
      ).toBeUndefined();
      const refresh = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.type, "refresh_timers"));
      expect(refresh.map((j) => j.payload)).toEqual([
        { triggerId: trigger.id },
      ]);
    });
  });
});
