import { describe, expect, test } from "bun:test";
import {
  calendarMutationRequestSchema,
  calendarMutationTimingSchema,
} from "@winston/contracts/calendar-mutations";
import { prepareCalendarMutation } from "@winston/adapters/google";
import { canonicalJson } from "@winston/contracts/json";

const operationId = "11111111-1111-4111-8111-111111111111";
const target = {
  connectionId: "22222222-2222-4222-8222-222222222222",
  calendarId: "team@example.com",
  operation: "calendar.write" as const,
  connectionRevision: 3,
  preferencesRevision: 2,
  email: "owner@example.com",
  label: "Work",
};
const timing = {
  kind: "timed" as const,
  start: "2026-03-08T01:30:00-05:00",
  end: "2026-03-08T03:30:00-04:00",
  timezone: "America/New_York",
};
const event = {
  summary: "Planning",
  description: "Agenda",
  location: "Office",
  timing,
  attendees: [{ email: "guest@example.com" }],
  recurrence: [],
  transparency: "opaque" as const,
};
const create = { kind: "create", target, sendUpdates: "all", event };
const snapshot = {
  source: { ...target, operation: "calendar.read" },
  trust: "untrusted_external_content",
  event: {
    id: "event1",
    etag: '"version1"',
    eventType: "default",
    status: "confirmed",
    summary: "Planning",
    start: { dateTime: timing.start, timeZone: timing.timezone },
    end: { dateTime: timing.end, timeZone: timing.timezone },
    organizer: { email: "owner@example.com", self: true },
    attendees: [
      {
        email: "guest@example.com",
        responseStatus: "accepted",
        optional: true,
        comment: "Coming",
        additionalGuests: 1,
        displayName: "Guest",
        self: false,
      },
    ],
  },
};
const update = {
  kind: "update",
  target,
  sendUpdates: "all",
  eventId: "event1",
  etag: '"version1"',
  scope: { kind: "single" },
  changes: { summary: "Updated planning" },
};

describe("Calendar mutation preparation", () => {
  test("creates a stable provider identity without contacting a provider", () => {
    const first = prepareCalendarMutation(operationId, create);
    const second = prepareCalendarMutation(operationId, create);
    expect(second).toEqual(first);
    expect(first.eventId).toBe("11111111111141118111111111111111");
    expect(first.eventId).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(first.method).toBe("POST");
    expect(first.path).toBe("calendars/team%40example.com/events");
    expect(first.ifMatch).toBeNull();
    expect(first.body).toMatchObject({
      id: first.eventId,
      start: snapshot.event.start,
      end: snapshot.event.end,
    });
    expect(first.potentialNotificationRecipients).toEqual(["guest@example.com"]);
  });

  test("requires explicit notification choices and rejects extra writable fields", () => {
    const missing = { ...create, sendUpdates: undefined };
    expect(calendarMutationRequestSchema.safeParse(missing).success).toBe(false);
    expect(
      calendarMutationRequestSchema.safeParse({ ...create, sendUpdates: "allGuests" }).success,
    ).toBe(false);
    expect(
      calendarMutationRequestSchema.safeParse({
        ...create,
        event: { ...event, organizer: { email: "other@example.com" } },
      }).success,
    ).toBe(false);
    expect(calendarMutationRequestSchema.safeParse({ ...update, changes: {} }).success).toBe(false);
    expect(
      calendarMutationRequestSchema.safeParse({
        ...create,
        event: {
          ...event,
          attendees: [{ email: "guest@example.com" }, { email: "GUEST@example.com" }],
        },
      }).success,
    ).toBe(false);
  });

  test("binds all notification and content changes into the exact plan", () => {
    const first = canonicalJson(prepareCalendarMutation(operationId, create));
    expect(
      canonicalJson(prepareCalendarMutation(operationId, { ...create, sendUpdates: "none" })),
    ).not.toBe(first);
    expect(
      canonicalJson(
        prepareCalendarMutation(operationId, {
          ...create,
          event: { ...event, summary: "Changed" },
        }),
      ),
    ).not.toBe(first);
    expect(
      canonicalJson(
        prepareCalendarMutation(operationId, {
          ...create,
          target: { ...target, calendarId: "other@example.com" },
        }),
      ),
    ).not.toBe(first);
  });

  test("validates target-date DST offsets and exclusive all-day ends", () => {
    expect(calendarMutationTimingSchema.safeParse(timing).success).toBe(true);
    expect(
      calendarMutationTimingSchema.safeParse({ ...timing, timezone: "Not/A_Zone" }).success,
    ).toBe(false);
    expect(
      calendarMutationTimingSchema.safeParse({ ...timing, start: "2026-03-08T02:30:00-05:00" })
        .success,
    ).toBe(false);
    expect(
      calendarMutationTimingSchema.safeParse({ ...timing, start: "2026-03-08T01:30:00" }).success,
    ).toBe(false);
    expect(calendarMutationTimingSchema.safeParse({ ...timing, end: timing.start }).success).toBe(
      false,
    );
    expect(
      calendarMutationTimingSchema.safeParse({
        kind: "all-day",
        start: "2026-03-08",
        end: "2026-03-09",
        timezone: "America/New_York",
      }).success,
    ).toBe(true);
    expect(
      calendarMutationTimingSchema.safeParse({
        kind: "all-day",
        start: "2026-03-08",
        end: "2026-03-08",
        timezone: "America/New_York",
      }).success,
    ).toBe(false);
    for (const offset of ["-04:00", "-05:00"]) {
      expect(
        calendarMutationTimingSchema.safeParse({
          ...timing,
          start: `2026-11-01T01:30:00${offset}`,
          end: "2026-11-01T03:30:00-05:00",
        }).success,
      ).toBe(true);
    }
  });

  test("patches only requested fields and carries the exact If-Match version", () => {
    const plan = prepareCalendarMutation(operationId, update, snapshot);
    expect(plan.method).toBe("PATCH");
    expect(plan.path).toBe("calendars/team%40example.com/events/event1");
    expect(plan.ifMatch).toBe('"version1"');
    expect(plan.body).toEqual({ summary: "Updated planning" });
    expect(plan.before?.summary).toBe("Planning");
    expect(() => prepareCalendarMutation(operationId, update)).toThrow();
    expect(() =>
      prepareCalendarMutation(operationId, update, {
        ...snapshot,
        event: { ...snapshot.event, etag: '"version2"' },
      }),
    ).toThrow("stale");
    expect(() =>
      prepareCalendarMutation(operationId, update, {
        ...snapshot,
        source: { ...snapshot.source, calendarId: "other" },
      }),
    ).toThrow("stale");
    expect(() =>
      prepareCalendarMutation(operationId, update, {
        ...snapshot,
        source: { ...snapshot.source, connectionRevision: 4 },
      }),
    ).toThrow("stale");
  });

  test("refuses incomplete, canceled, locked and special-purpose provider events", () => {
    for (const change of [
      { attendeesOmitted: true },
      { attendees: [{}] },
      { status: "cancelled" },
      { locked: true },
      { eventType: "outOfOffice" },
      { endTimeUnspecified: true },
    ]) {
      expect(() =>
        prepareCalendarMutation(operationId, update, {
          ...snapshot,
          event: { ...snapshot.event, ...change },
        }),
      ).toThrow();
    }
  });

  test("requires explicit instance identity and never substitutes the parent series ID", () => {
    const occurrence = {
      ...snapshot,
      event: {
        ...snapshot.event,
        id: "series1_20260308T063000Z",
        recurringEventId: "series1",
        originalStartTime: snapshot.event.start,
      },
    };
    const request = {
      ...update,
      eventId: occurrence.event.id,
      scope: {
        kind: "instance",
        recurringEventId: "series1",
        originalStartTime: snapshot.event.start,
      },
    };
    const plan = prepareCalendarMutation(operationId, request, occurrence);
    expect(plan.path).toEndWith(`/events/${occurrence.event.id}`);
    expect(() =>
      prepareCalendarMutation(operationId, { ...request, scope: { kind: "series" } }, occurrence),
    ).toThrow("scope");
    expect(() =>
      prepareCalendarMutation(
        operationId,
        { ...request, scope: { ...request.scope, recurringEventId: "another" } },
        occurrence,
      ),
    ).toThrow("identity");
    expect(() =>
      prepareCalendarMutation(operationId, { ...request, changes: { recurrence: [] } }, occurrence),
    ).toThrow("whole-series");
  });

  test("requires whole-series scope to change an existing recurrence", () => {
    const recurring = {
      ...snapshot,
      event: { ...snapshot.event, recurrence: ["RRULE:FREQ=WEEKLY"] },
    };
    expect(() => prepareCalendarMutation(operationId, update, recurring)).toThrow("scope");
    const plan = prepareCalendarMutation(
      operationId,
      { ...update, scope: { kind: "series" }, changes: { recurrence: [] } },
      recurring,
    );
    expect(plan.body).toEqual({ recurrence: [] });
    expect(
      calendarMutationRequestSchema.safeParse({
        ...create,
        event: { ...event, recurrence: ["DTSTART:20260308T063000Z"] },
      }).success,
    ).toBe(false);
    expect(
      calendarMutationRequestSchema.safeParse({
        ...create,
        event: { ...event, recurrence: ["RRULE:FREQ=DAILY\r\nDTEND:20260308"] },
      }).success,
    ).toBe(false);
  });

  test("preserves unchanged attendee metadata and reviews removed as well as new guests", () => {
    const plan = prepareCalendarMutation(
      operationId,
      {
        ...update,
        changes: {
          attendees: [
            { email: "guest@example.com", optional: false },
            { email: "new@example.com" },
          ],
        },
      },
      snapshot,
    );
    expect(plan.body?.attendees).toEqual([
      {
        email: "guest@example.com",
        optional: false,
        responseStatus: "accepted",
        comment: "Coming",
        additionalGuests: 1,
        displayName: "Guest",
      },
      { email: "new@example.com" },
    ]);
    const removed = prepareCalendarMutation(
      operationId,
      { ...update, changes: { attendees: [{ email: "new@example.com" }] } },
      snapshot,
    );
    expect(removed.potentialNotificationRecipients).toContain("guest@example.com");
    expect(removed.potentialNotificationRecipients).toContain("new@example.com");
    expect(() =>
      prepareCalendarMutation(
        operationId,
        { ...update, changes: { attendees: [] } },
        { ...snapshot, event: { ...snapshot.event, organizer: { self: false } } },
      ),
    ).toThrow("organizer");
  });

  test("deletion retains event context and sends no replacement body", () => {
    const request = {
      target,
      eventId: update.eventId,
      etag: update.etag,
      scope: update.scope,
    };
    const plan = prepareCalendarMutation(
      operationId,
      { ...request, kind: "delete", sendUpdates: "externalOnly" },
      snapshot,
    );
    expect(plan.method).toBe("DELETE");
    expect(plan.body).toBeNull();
    expect(plan.ifMatch).toBe('"version1"');
    expect(plan.before?.attendees).toHaveLength(1);
    expect(plan.sendUpdates).toBe("externalOnly");
  });

  test("refuses plans too large for the approval record", () => {
    expect(() =>
      prepareCalendarMutation(operationId, update, {
        ...snapshot,
        event: { ...snapshot.event, description: "a".repeat(100_000) },
      }),
    ).toThrow("too large");
  });
});
