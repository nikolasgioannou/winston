import { describe, expect, test } from "bun:test";
import { refFor } from "@winston/db/external-refs";
import { auditLog } from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertRun,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { eq } from "drizzle-orm";
import { setupApi } from "./testing.ts";

const db = await testDb();
const scopes = ["calendar.events"];
const everything = {
  read: true,
  create: true,
  update: true,
  delete: true,
  rsvp: true,
};

type Json = Record<string, unknown>;
const json = async (response: Response) => (await response.json()) as Json;
const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe("calendar writes", () => {
  test("create resolves times in the user's zone, invites attendees by default, and is on the audit log", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      const run = await insertRun(tx, user.id);
      const connection = await insertConnection(tx, user.id, {
        domain: "calendar",
        scopes,
        capabilities: everything,
        externalEmail: "me@example.com",
      });
      const { as, calendar } = setupApi(tx);
      const call = as(user.id, run.id);
      const event = {
        title: "Plan review",
        start: "2026-10-06T15:00",
        duration: 45,
        attendees: ["dana@other.com"],
        video: true,
        repeat: "FREQ=WEEKLY;BYDAY=TU",
      };

      const preview = await json(
        await call("/v1/calendar/events", {
          method: "POST",
          body: { ...event, dryRun: true },
        }),
      );
      expect(preview).toMatchObject({
        dryRun: true,
        notifies: ["dana@other.com"],
        event: {
          start: { at: "2026-10-06T19:00:00.000Z" },
          end: { at: "2026-10-06T19:45:00.000Z" },
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
        },
      });
      expect(calendar.created).toHaveLength(0);

      const made = await json(
        await call("/v1/calendar/events", { method: "POST", body: event }),
      );
      expect((made.event as { id: string }).id).toStartWith("evt_");
      expect(calendar.created[0]).toMatchObject({
        notify: true,
        event: {
          title: "Plan review",
          video: true,
          timeZone: "America/New_York",
        },
      });
      const [row] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.connectionId, connection.id));
      expect(row).toMatchObject({
        action: "calendar.create",
        outcome: "ok",
        resultRef: "me@example.com/new",
      });

      await call("/v1/calendar/events", {
        method: "POST",
        body: { title: "Focus", start: "2026-10-07", allDay: true },
      });
      expect(calendar.created[1]).toMatchObject({
        notify: false,
        event: { start: { date: "2026-10-07" }, end: { date: "2026-10-08" } },
      });
    });
  });

  test("update keeps the length when moving, scopes series changes, and notifies everyone on it", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      const run = await insertRun(tx, user.id);
      const connection = await insertConnection(tx, user.id, {
        domain: "calendar",
        scopes,
        capabilities: everything,
        externalEmail: "me@example.com",
      });
      const id = await refFor(
        tx,
        user.id,
        connection.id,
        "calendarEvent",
        "me@example.com/e1",
      );
      const { as, calendar } = setupApi(tx);
      const call = as(user.id, run.id);
      const moved = await json(
        await call(`/v1/calendar/events/${id}`, {
          method: "PATCH",
          body: {
            start: "2026-10-01T16:00",
            addAttendees: ["sam@other.com"],
            scope: "following",
          },
        }),
      );
      expect(moved.notifies).toEqual(["dana@other.com", "sam@other.com"]);
      // Moved without an end: it says the 30-minute length was kept.
      expect(moved.keptMinutes).toBe(30);
      expect(calendar.updated[0]).toMatchObject({
        id: "me@example.com/e1",
        scope: "following",
        notify: true,
        changes: {
          start: { at: new Date("2026-10-01T20:00:00Z") },
          end: { at: new Date("2026-10-01T20:30:00Z") },
          addAttendees: ["sam@other.com"],
        },
      });

      const renamed = await json(
        await call(`/v1/calendar/events/${id}`, {
          method: "PATCH",
          body: { title: "Renamed", notify: false },
        }),
      );
      expect(renamed.keptMinutes).toBeNull();
      expect(calendar.updated[1]).toMatchObject({
        notify: false,
        scope: "this",
        changes: { title: "Renamed" },
      });
      expect(calendar.updated[1]?.changes.start).toBeUndefined();
    });
  });

  test("delete and RSVP act on the event, and RSVP needs an invitation", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id);
      const connection = await insertConnection(tx, user.id, {
        domain: "calendar",
        scopes,
        capabilities: everything,
        externalEmail: "me@example.com",
      });
      const ref = (key: string) =>
        refFor(
          tx,
          user.id,
          connection.id,
          "calendarEvent",
          `me@example.com/${key}`,
        );
      const { as, calendar } = setupApi(tx);
      const call = as(user.id, run.id);

      const dry = await json(
        await call(`/v1/calendar/events/${await ref("e1")}/delete`, {
          method: "POST",
          body: { dryRun: true },
        }),
      );
      expect(dry).toMatchObject({ dryRun: true, notifies: ["dana@other.com"] });
      expect(calendar.deleted).toHaveLength(0);
      await call(`/v1/calendar/events/${await ref("e1")}/delete`, {
        method: "POST",
        body: { scope: "all" },
      });
      expect(calendar.deleted[0]).toEqual({
        id: "me@example.com/e1",
        scope: "all",
        notify: true,
      });

      const answer = await json(
        await call(`/v1/calendar/events/${await ref("invite")}/rsvp`, {
          method: "POST",
          body: { response: "declined", note: "Out that day" },
        }),
      );
      expect(answer).toMatchObject({
        response: "declined",
        organizer: "boss@other.com",
      });
      expect(calendar.answered[0]).toMatchObject({
        id: "me@example.com/invite",
        response: "declined",
        note: "Out that day",
      });
      expect(
        await errorCode(
          await call(`/v1/calendar/events/${await ref("solo")}/rsvp`, {
            method: "POST",
            body: { response: "accepted" },
          }),
        ),
      ).toBe("not_supported");
      const actions = (
        await tx
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.connectionId, connection.id))
      ).map((r) => r.action);
      expect(actions.sort()).toEqual(["calendar.delete", "calendar.rsvp"]);
    });
  });

  test("each write needs its capability, even as a dry run, and bad flags are refused", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id);
      const connection = await insertConnection(tx, user.id, {
        domain: "calendar",
        scopes,
        capabilities: { read: true },
        externalEmail: "me@example.com",
      });
      const id = await refFor(
        tx,
        user.id,
        connection.id,
        "calendarEvent",
        "me@example.com/invite",
      );
      const call = setupApi(tx).as(user.id, run.id);
      const post = async (path: string, body: unknown, method = "POST") =>
        errorCode(await call(path, { method, body }));
      expect(
        await post("/v1/calendar/events", {
          title: "x",
          start: "tomorrow 9am",
          duration: 30,
          dryRun: true,
        }),
      ).toBe("permission_disabled");
      expect(
        await post(
          `/v1/calendar/events/${id}`,
          { title: "y", dryRun: true },
          "PATCH",
        ),
      ).toBe("permission_disabled");
      expect(
        await post(`/v1/calendar/events/${id}/delete`, { dryRun: true }),
      ).toBe("permission_disabled");
      expect(
        await post(`/v1/calendar/events/${id}/rsvp`, {
          response: "accepted",
          dryRun: true,
        }),
      ).toBe("permission_disabled");
    });
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, {
        domain: "calendar",
        scopes,
        capabilities: everything,
      });
      const call = setupApi(tx).as(user.id);
      const post = async (body: unknown) =>
        errorCode(await call("/v1/calendar/events", { method: "POST", body }));
      expect(await post({ title: "x", start: "tomorrow 9am" })).toBe(
        "invalid_request",
      );
      expect(
        await post({
          title: "x",
          start: "tomorrow 9am",
          duration: 30,
          allDay: true,
        }),
      ).toBe("invalid_request");
      expect(
        await post({
          title: "x",
          start: "tomorrow 9am",
          end: "tomorrow 8am",
        }),
      ).toBe("invalid_request");
      expect(
        await post({
          title: "x",
          start: "tomorrow 9am",
          duration: 30,
          repeat: "every tuesday",
        }),
      ).toBe("invalid_request");
    });
  });
});
