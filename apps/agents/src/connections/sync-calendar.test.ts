import { describe, expect, test } from "bun:test";
import type { GoogleEvent } from "@winston/connectors/google-calendar";
import { SyncTokenExpiredError } from "@winston/connectors/google-calendar-sync";
import type { DbOrTx } from "@winston/db/client";
import {
  auditLog,
  calendarEventSnapshots,
  connections,
  events,
} from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { eq } from "drizzle-orm";
import { syncCalendar, type CalendarSyncDeps } from "./sync-calendar.ts";

const db = await testDb();
const me = "me@example.com";
const now = new Date("2026-10-01T12:00:00Z");

const meeting = (overrides: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: "e1",
  status: "confirmed",
  summary: "Sync with Dana",
  start: { dateTime: "2026-10-02T19:00:00Z" },
  end: { dateTime: "2026-10-02T19:30:00Z" },
  organizer: { email: me, self: true },
  attendees: [
    { email: me, responseStatus: "accepted", self: true },
    { email: "dana@other.com", responseStatus: "needsAction" },
  ],
  created: "2026-10-01T11:00:00Z",
  updated: "2026-10-01T11:00:00Z",
  ...overrides,
});

/** Google Calendar standing in: each call to `changes` answers with the next batch. */
function calendar(batches: (GoogleEvent[] | "expired")[]): CalendarSyncDeps {
  let call = 0;
  return {
    sync: {
      watchedCalendars: () => Promise.resolve([me]),
      changes: (
        _calendarId: string,
        from: { syncToken: string } | { since: Date },
      ) => {
        const batch = batches[call] ?? [];
        call += 1;
        if (batch === "expired" && "syncToken" in from)
          return Promise.reject(new SyncTokenExpiredError("410"));
        return Promise.resolve({
          events: batch === "expired" ? [] : batch,
          nextSyncToken: `token-${String(call)}`,
        });
      },
      watch: () => Promise.reject(new Error("unused")),
      stopChannel: () => Promise.resolve(),
    },
  };
}

async function setup(tx: DbOrTx) {
  const user = await insertUser(tx);
  return insertConnection(tx, user.id, {
    domain: "calendar",
    externalEmail: me,
  });
}

/** Runs syncs in turn on the same connection (re-reading its state each time). */
async function syncs(tx: DbOrTx, batches: (GoogleEvent[] | "expired")[]) {
  const connection = await setup(tx);
  const deps = calendar(batches);
  const results = [];
  // One sync per batch (a 410's re-list consumes the batch after it).
  while (results.length < batches.length) {
    const [row] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, connection.id));
    if (!row) throw new Error("no connection");
    results.push(await syncCalendar(tx, row, deps, now));
  }
  return { connection, results };
}

const types = (stored: { type: string }[]) => stored.map((e) => e.type);

describe("calendar sync", () => {
  test("the first sync takes its place and remembers events; a new one after is created, self-caused when Winston made it", async () => {
    await inRollback(db, async (tx) => {
      const connection = await setup(tx);
      await tx.insert(auditLog).values({
        userId: connection.userId,
        connectionId: connection.id,
        action: "calendar.create",
        summary: "Created",
        request: {},
        outcome: "ok",
        resultRef: `${me}/e2`,
      });
      const deps = calendar([
        [meeting()],
        [meeting({ id: "e2" }), meeting({ id: "e3" })],
      ]);
      const first = await syncCalendar(tx, connection, deps, now);
      expect(first).toEqual([]);
      const snaps = await tx.select().from(calendarEventSnapshots);
      expect(snaps.map((s) => s.providerId)).toEqual([`${me}/e1`]);
      const [row] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, connection.id));
      const second = await syncCalendar(tx, row ?? connection, deps, now);
      expect(second.map((e) => [e.type, e.selfCaused])).toEqual([
        ["calendar.event.created", true],
        ["calendar.event.created", false],
      ]);
      expect(
        (second[0]?.payload as { event: { eventId: string } }).event.eventId,
      ).toStartWith("evt_");
    });
  });

  test("someone else's event with the user invited is an invitation", async () => {
    await inRollback(db, async (tx) => {
      const { results } = await syncs(tx, [
        [],
        [
          meeting({
            id: "inv",
            organizer: { email: "pat@acme.com" },
            attendees: [
              { email: "pat@acme.com", responseStatus: "accepted" },
              { email: me, responseStatus: "needsAction", self: true },
            ],
          }),
        ],
      ]);
      expect(types(results[1] ?? [])).toEqual(["calendar.invitation.received"]);
    });
  });

  test("an update lists the changed fields before and after; a change to nothing diffed is no event", async () => {
    await inRollback(db, async (tx) => {
      const { results } = await syncs(tx, [
        [meeting()],
        [
          meeting({
            start: { dateTime: "2026-10-03T19:00:00Z" },
            end: { dateTime: "2026-10-03T19:30:00Z" },
            location: "Room 4",
            updated: "2026-10-01T11:30:00Z",
          }),
        ],
        [
          meeting({
            start: { dateTime: "2026-10-03T19:00:00Z" },
            end: { dateTime: "2026-10-03T19:30:00Z" },
            location: "Room 4",
            updated: "2026-10-01T11:40:00Z",
          }),
        ],
      ]);
      const [updated] = results[1] ?? [];
      expect(updated?.type).toBe("calendar.event.updated");
      expect((updated?.payload as { changes: unknown[] }).changes).toEqual([
        {
          field: "start",
          before: { at: "2026-10-02T19:00:00.000Z" },
          after: { at: "2026-10-03T19:00:00.000Z" },
        },
        {
          field: "end",
          before: { at: "2026-10-02T19:30:00.000Z" },
          after: { at: "2026-10-03T19:30:00.000Z" },
        },
        { field: "location", before: null, after: "Room 4" },
      ]);
      expect(results[2]).toEqual([]);
    });
  });

  test("an attendee answering the user's event is an rsvp change; the user's own answer isn't", async () => {
    await inRollback(db, async (tx) => {
      const { results } = await syncs(tx, [
        [meeting()],
        [
          meeting({
            attendees: [
              { email: me, responseStatus: "tentative", self: true },
              { email: "dana@other.com", responseStatus: "accepted" },
            ],
            updated: "2026-10-01T11:30:00Z",
          }),
        ],
      ]);
      expect(
        results[1]?.map((e) => [
          e.type,
          (e.payload as { response?: string }).response,
        ]),
      ).toEqual([["calendar.rsvp.changed", "accepted"]]);
    });
  });

  test("a cancellation is reported from what was known, and a cancelled instance from its series", async () => {
    await inRollback(db, async (tx) => {
      const series = meeting({
        id: "weekly",
        summary: "1:1",
        recurrence: ["RRULE:FREQ=WEEKLY"],
      });
      const { results } = await syncs(tx, [
        [meeting(), series],
        [
          { id: "e1", status: "cancelled", updated: "2026-10-01T11:30:00Z" },
          {
            id: "weekly_20261009T190000Z",
            status: "cancelled",
            recurringEventId: "weekly",
            originalStartTime: { dateTime: "2026-10-09T19:00:00Z" },
            updated: "2026-10-01T11:31:00Z",
          },
        ],
      ]);
      const cancelled = results[1] ?? [];
      expect(types(cancelled)).toEqual([
        "calendar.event.cancelled",
        "calendar.event.cancelled",
      ]);
      expect(
        (cancelled[0]?.payload as { event: { title: string } }).event.title,
      ).toBe("Sync with Dana");
      expect(
        (cancelled[1]?.payload as { event: { title: string; start: unknown } })
          .event,
      ).toMatchObject({
        title: "1:1",
        start: { at: "2026-10-09T19:00:00.000Z" },
      });
      const snaps = await tx.select().from(calendarEventSnapshots);
      expect(snaps.map((s) => s.providerId)).toEqual([`${me}/weekly`]);
    });
  });

  test("an expired sync token re-lists the window and diffs it against what's known", async () => {
    await inRollback(db, async (tx) => {
      const { results } = await syncs(tx, [[meeting()], "expired"]);
      // The re-list came back empty here; nothing new, nothing lost.
      expect(results[1]).toEqual([]);
      // The re-list (the batch after "expired") is diffed in the same sync.
      const { results: again } = await syncs(tx, [
        [meeting()],
        "expired",
        [meeting({ location: "Room 9", updated: "2026-10-01T11:50:00Z" })],
      ]);
      expect(types(again[1] ?? [])).toEqual(["calendar.event.updated"]);
    });
  });

  test("syncing the same changes twice stores them once", async () => {
    await inRollback(db, async (tx) => {
      const change = meeting({ id: "e9", updated: "2026-10-01T11:30:00Z" });
      const connection = await setup(tx);
      const deps = calendar([[], [change]]);
      await syncCalendar(tx, connection, deps, now);
      const [row] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, connection.id));
      if (!row) throw new Error("no row");
      expect(await syncCalendar(tx, row, deps, now)).toHaveLength(1);
      // Replaying from the same token (a retried job) stores nothing new.
      await tx.delete(calendarEventSnapshots);
      expect(
        await syncCalendar(tx, row, calendar([[change]]), now),
      ).toHaveLength(0);
      expect(await tx.select().from(events)).toHaveLength(1);
    });
  });
});
