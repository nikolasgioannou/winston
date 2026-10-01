import { describe, expect, test } from "bun:test";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { setupApi } from "./testing.ts";

const db = await testDb();
const scopes = ["calendar.events"];

type Json = Record<string, unknown>;

describe("calendar routes", () => {
  test("list defaults to now through a week, resolves times in the user's zone, and names events by evt_ ids", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      await insertConnection(tx, user.id, {
        domain: "calendar",
        scopes,
        externalEmail: "me@example.com",
      });
      const { as, calendar } = setupApi(tx);
      const call = as(user.id);
      const before = Date.now();
      const body = (await (
        await call("/v1/calendar/events?attendee=dana")
      ).json()) as {
        timeZone: string;
        events: {
          id: string;
          seriesId: string | null;
          external: boolean;
          allDay: boolean;
          start: unknown;
        }[];
      };
      const filter = calendar.filters[0];
      expect(filter?.attendee).toBe("dana");
      expect(filter?.since.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(
        (filter?.until.getTime() ?? 0) - (filter?.since.getTime() ?? 0),
      ).toBe(7 * 24 * 3600_000);
      expect(body.timeZone).toBe("America/New_York");
      expect(body.events[0]?.id).toStartWith("evt_");
      expect(body.events[0]?.seriesId ?? "").toStartWith("evt_");
      expect(body.events[0]?.external).toBe(true);
      expect(body.events[1]).toMatchObject({
        allDay: true,
        start: { date: "2026-09-30" },
      });

      await call("/v1/calendar/events?since=2026-09-29&until=2026-09-30");
      expect(calendar.filters[1]?.since).toEqual(
        new Date("2026-09-29T04:00:00Z"),
      );
      const detail = (await (
        await call(`/v1/calendar/events/${body.events[0]?.id ?? ""}`)
      ).json()) as {
        event: { id: string; title: string };
      };
      expect(detail.event.id).toBe(body.events[0]?.id ?? "");
    });
  });

  test("free finds gaps around everyone's busy time inside working hours, and says whose time it couldn't see", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      await insertConnection(tx, user.id, {
        domain: "calendar",
        scopes,
        externalEmail: "me@example.com",
      });
      const call = setupApi(tx).as(user.id);
      const body = (await (
        await call(
          "/v1/calendar/free?since=2026-09-29T00:00&until=2026-09-30T00:00&duration=60&attendee=dana@other.com&attendee=hidden@x.com",
        )
      ).json()) as Json;
      // Busy 10–11 (me) and 15–16 (Dana), local; 9–18 working hours.
      expect(body.slots).toEqual([
        { start: "2026-09-29T13:00:00.000Z", end: "2026-09-29T14:00:00.000Z" },
        { start: "2026-09-29T15:00:00.000Z", end: "2026-09-29T19:00:00.000Z" },
        { start: "2026-09-29T20:00:00.000Z", end: "2026-09-29T22:00:00.000Z" },
      ]);
      expect(body.considered).toEqual([
        { who: "me@example.com", visible: true },
        { who: "dana@other.com", visible: true },
        { who: "hidden@x.com", visible: false },
      ]);
      const narrow = (await (
        await call(
          "/v1/calendar/free?since=2026-09-29T00:00&until=2026-09-30T00:00&duration=60&hours=16-18",
        )
      ).json()) as Json;
      expect(narrow.slots).toEqual([
        { start: "2026-09-29T20:00:00.000Z", end: "2026-09-29T22:00:00.000Z" },
      ]);
      const twelveHour = (await (
        await call(
          "/v1/calendar/free?since=2026-09-29T00:00&until=2026-09-30T00:00&duration=60&hours=4pm-6pm",
        )
      ).json()) as Json;
      expect(twelveHour.slots).toEqual(narrow.slots);
    });
  });

  test("no calendar account, reading off, and bad flags", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const call = setupApi(tx).as(user.id);
      const code = async (path: string) =>
        ((await (await call(path)).json()) as { error: { code: string } }).error
          .code;
      expect(await code("/v1/calendar/events")).toBe("not_found");
      await insertConnection(tx, user.id, {
        domain: "calendar",
        scopes,
        capabilities: { read: false },
      });
      expect(await code("/v1/calendar/events")).toBe("permission_disabled");
    });
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, { domain: "calendar", scopes });
      const call = setupApi(tx).as(user.id);
      const code = async (path: string) =>
        ((await (await call(path)).json()) as { error: { code: string } }).error
          .code;
      expect(await code("/v1/calendar/free?hours=18-9")).toBe(
        "invalid_request",
      );
      expect(await code("/v1/calendar/events?since=whenever")).toBe(
        "invalid_request",
      );
    });
  });
});
