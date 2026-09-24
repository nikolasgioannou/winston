import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import {
  createCalendarReader,
  createConnectionTargets,
  createCalendarAvailabilityReader,
} from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import {
  calendarEventQuerySchema,
  calendarProviderEventSchema,
  calendarReadTargetSchema,
} from "@winston/contracts/calendar";
import { withTestPostgres } from "../../src/postgres";

test("Calendar windows retain date boundaries, recurrence and account-scoped pagination", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const stranger = randomUUID();
    const calendarId = "team@example.com";
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 3).toString("base64") }),
    );
    const grant = {
      accessToken: "synthetic",
      refreshToken: "synthetic",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scopes: [...googleScopes.calendar] as string[],
    };
    const google = {
      list: (id: string) => database.transaction(id, ({ connections }) => connections.list()),
      calendars: () =>
        Promise.resolve([
          { id: calendarId, summary: "Team", accessRole: "owner" as const },
          { id: "excluded", summary: "Excluded", accessRole: "owner" as const },
        ]),
      access: () => Promise.resolve({ kind: "ready" as const, grant, revision: 0 }),
      rejected: () => Promise.resolve(),
    };
    let requests = 0;
    let malformed = false;
    const timed = {
      id: "event1",
      summary: "DST meeting",
      start: { dateTime: "2026-11-01T01:30:00-04:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-11-01T01:30:00-05:00", timeZone: "America/New_York" },
      recurringEventId: "series1",
      originalStartTime: { dateTime: "2026-11-01T01:00:00-04:00", timeZone: "America/New_York" },
    };
    const allDay = {
      id: "event2",
      start: { date: "2026-11-01" },
      end: { date: "2026-11-02" },
      transparency: "transparent",
    };
    const canceled = {
      id: "event3",
      status: "cancelled",
      recurringEventId: "series1",
      originalStartTime: { dateTime: "2026-11-02T09:00:00-05:00" },
    };
    const reader = createCalendarReader({
      database,
      google,
      fetch: (url, init) => {
        requests += 1;
        assert.equal(url.origin, "https://www.googleapis.com");
        assert.ok(url.pathname.startsWith("/calendar/v3/calendars/team%40example.com/events"));
        assert.equal(init.redirect, "error");
        assert.equal(init.method, "GET");
        if (malformed) return Promise.resolve(Response.json({ items: [{ id: "broken" }] }));
        if (url.pathname.endsWith("/event1")) return Promise.resolve(Response.json(timed));
        assert.equal(url.searchParams.get("singleEvents"), "true");
        assert.equal(url.searchParams.get("showDeleted"), "true");
        assert.equal(url.searchParams.get("timeZone"), "America/New_York");
        return Promise.resolve(
          Response.json(
            url.searchParams.has("pageToken")
              ? { timeZone: "America/New_York", items: [timed, allDay, canceled] }
              : { items: [], nextPageToken: "next" },
          ),
        );
      },
    });
    const signal = new AbortController().signal;
    const window = {
      timeMin: "2026-11-01T00:00:00-04:00",
      timeMax: "2026-11-03T00:00:00-05:00",
      timezone: "America/New_York",
    };
    async function connect() {
      const id = randomUUID();
      const connection: Connection = {
        id,
        service: "calendar",
        subject: id,
        email: `${id}@example.com`,
        scopes: [...googleScopes.calendar],
        status: "connected",
        revision: 0,
        calendars: [calendarId],
      };
      await vault.put(ownerId, id, grant, null);
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document) VALUES (${ownerId}::uuid, ${id}::uuid, ${id}, 'calendar', ${JSON.stringify(connection)}::text::jsonb)`;
      const result = await createConnectionTargets(database, google).resolve(
        ownerId,
        { operation: "calendar.read", explicit: { connectionId: id, calendarId } },
        signal,
      );
      assert.equal(result.status, "resolved");
      return calendarReadTargetSchema.parse(result.target);
    }
    try {
      for (const id of [ownerId, stranger])
        await database.transaction(id, ({ owners }) => owners.ensure());
      const first = await connect();
      const second = await connect();
      await assert.rejects(
        reader.events(ownerId, { target: first, window }, signal),
        /approval_required/,
      );
      assert.equal(requests, 0);
      for (const [revision, target] of [first, second].entries())
        await database.transaction(ownerId, ({ authorization }) =>
          authorization.put({
            target: { kind: "connection", id: target.connectionId, resource: calendarId },
            operation: "calendar.read",
            decision: "allow",
            revision,
          }),
        );
      const page = await reader.events(ownerId, { target: first, window, limit: 3 }, signal);
      assert.deepEqual(page.events, []);
      assert.ok(page.cursor);
      const next = await reader.events(
        ownerId,
        { target: first, window, limit: 3, cursor: page.cursor },
        signal,
      );
      assert.equal(next.cursor, null);
      assert.equal(next.source.connectionId, first.connectionId);
      assert.equal(next.source.calendarId, calendarId);
      assert.equal(next.trust, "untrusted_external_content");
      assert.deepEqual(next.events[0]?.start, timed.start);
      assert.deepEqual(next.events[0].end, timed.end);
      assert.deepEqual(next.events[0].originalStartTime, timed.originalStartTime);
      assert.equal(Date.parse(timed.end.dateTime) - Date.parse(timed.start.dateTime), 3_600_000);
      assert.deepEqual(next.events[1]?.start, { date: "2026-11-01" });
      assert.deepEqual(next.events[1].end, { date: "2026-11-02" });
      assert.equal(next.events[1].transparency, "transparent");
      assert.equal(next.events[2]?.status, "cancelled");
      assert.equal(next.events[2].start, undefined);
      assert.equal(
        (await reader.event(ownerId, { target: first, id: "event1" }, signal)).event.id,
        "event1",
      );
      const before = requests;
      let availabilityRequests = 0;
      let availabilityData: unknown = {};
      const availability = createCalendarAvailabilityReader({
        database,
        google,
        fetch: (url, init) => {
          availabilityRequests += 1;
          assert.equal(url.href, "https://www.googleapis.com/calendar/v3/freeBusy");
          assert.equal(init.method, "POST");
          assert.equal(typeof init.body, "string");
          assert.deepEqual(JSON.parse(init.body as string), {
            timeMin: window.timeMin,
            timeMax: window.timeMax,
            timeZone: window.timezone,
            calendarExpansionMax: 1,
            groupExpansionMax: 1,
            items: [{ id: calendarId }],
          });
          return Promise.resolve(Response.json(availabilityData));
        },
      });
      await assert.rejects(
        availability(ownerId, { target: first, window }, signal),
        /reconnect_required/,
      );
      assert.equal(availabilityRequests, 0);
      grant.scopes.push("https://www.googleapis.com/auth/calendar.events.freebusy");
      const busy = [{ start: timed.start.dateTime, end: timed.end.dateTime }];
      const validAvailability = {
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        calendars: { [calendarId]: { busy } },
      };
      availabilityData = validAvailability;
      const available = await availability(ownerId, { target: first, window }, signal);
      assert.deepEqual(available.busy, busy);
      assert.equal(available.source.connectionId, first.connectionId);
      for (const malformedAvailability of [
        { ...validAvailability, calendars: {} },
        {
          ...validAvailability,
          calendars: { [calendarId]: { busy: [], errors: [{ reason: "newError" }] } },
        },
        { ...validAvailability, timeMax: window.timeMin },
        { ...validAvailability, groups: { secret: { calendars: ["excluded"] } } },
        {
          ...validAvailability,
          calendars: { [calendarId]: { busy: [{ start: window.timeMax, end: window.timeMin }] } },
        },
      ]) {
        availabilityData = malformedAvailability;
        await assert.rejects(
          availability(ownerId, { target: first, window }, signal),
          /unavailable/,
        );
      }
      availabilityData = { ...validAvailability, calendars: { [calendarId]: { busy: [] } } };
      assert.deepEqual((await availability(ownerId, { target: first, window }, signal)).busy, []);
      const previousAvailabilityRequests = availabilityRequests;
      await assert.rejects(availability(stranger, { target: first, window }, signal), /stale/);
      await assert.rejects(
        availability(ownerId, { target: { ...first, calendarId: "excluded" }, window }, signal),
        /stale/,
      );
      assert.equal(availabilityRequests, previousAvailabilityRequests);
      await assert.rejects(
        reader.events(ownerId, { target: second, window, cursor: page.cursor }, signal),
        /stale/,
      );
      await assert.rejects(
        reader.events(
          ownerId,
          {
            target: first,
            window: { ...window, timeMax: "2026-11-04T00:00:00-05:00" },
            cursor: page.cursor,
          },
          signal,
        ),
        /stale/,
      );
      await assert.rejects(reader.events(stranger, { target: first, window }, signal), /stale/);
      await assert.rejects(
        reader.events(ownerId, { target: { ...first, calendarId: "excluded" }, window }, signal),
        /stale/,
      );
      assert.equal(requests, before);
      malformed = true;
      await assert.rejects(
        reader.events(ownerId, { target: first, window }, signal),
        /unavailable/,
      );
      assert.equal(
        calendarEventQuerySchema.safeParse({
          target: first,
          window: { ...window, timeMax: window.timeMin },
        }).success,
        false,
      );
      assert.equal(
        calendarProviderEventSchema.safeParse({ id: "deleted", status: "cancelled" }).success,
        true,
      );
      assert.equal(
        calendarProviderEventSchema.safeParse({
          ...timed,
          start: { dateTime: "2026-11-01T01:30:00" },
        }).success,
        false,
      );
      assert.equal(
        calendarProviderEventSchema.safeParse({
          ...timed,
          start: { dateTime: "2026-11-01T01:30:00", timeZone: "America/New_York" },
        }).success,
        true,
      );
      assert.equal(
        calendarProviderEventSchema.safeParse({
          ...allDay,
          end: { dateTime: "2026-11-02T00:00:00Z" },
        }).success,
        false,
      );
    } finally {
      await database.close();
    }
  });
});
