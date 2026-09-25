import { test, expect } from "bun:test";
import { prepareCalendarMutation, calendarMutationStateMatches } from "@winston/adapters/google";

const operationId = "11111111-1111-4111-8111-111111111111";
const target = {
  connectionId: "22222222-2222-4222-8222-222222222222",
  calendarId: "team@example.com",
  operation: "calendar.write",
  connectionRevision: 0,
  preferencesRevision: 0,
  email: "owner@example.com",
  label: "Team",
};
const fields = {
  summary: "Focus",
  description: "",
  location: "",
  attendees: [],
  recurrence: [],
  transparency: "opaque",
  timing: { kind: "all-day", start: "2026-10-01", end: "2026-10-02", timezone: "America/New_York" },
};
const original = {
  id: "event1",
  etag: '"before"',
  eventType: "default",
  summary: "Before",
  start: { date: "2026-10-01" },
  end: { date: "2026-10-02" },
};
const snapshot = { source: { ...target, operation: "calendar.read" }, event: original };
const update = {
  kind: "update",
  target,
  sendUpdates: "all",
  eventId: original.id,
  etag: original.etag,
  scope: { kind: "single" },
  changes: { summary: "After" },
};

test("Calendar create reconciliation requires the stable ID and complete desired state", () => {
  const plan = prepareCalendarMutation(operationId, {
    kind: "create",
    target,
    sendUpdates: "none",
    event: fields,
  });
  const observed = {
    ...plan.body,
    eventType: "default",
    etag: '"observed"',
    start: original.start,
    end: original.end,
  };
  expect(calendarMutationStateMatches(plan, observed)).toBe(true);
  for (const mutation of [
    { id: "another" },
    { etag: undefined },
    { etag: "unquoted" },
    { eventType: "focusTime" },
    { summary: "Other" },
    { description: "Different" },
    { location: "Other" },
    { status: "cancelled" },
    { endTimeUnspecified: true },
    { attendeesOmitted: true },
    { attendees: [{ email: "extra@example.com" }] },
    { recurrence: ["RRULE:FREQ=DAILY"] },
    { recurringEventId: "parent" },
    { end: { date: "2026-10-03" } },
    { transparency: "transparent" },
  ])
    expect(calendarMutationStateMatches(plan, { ...observed, ...mutation })).toBe(false);
});

test("Calendar update reconciliation requires a changed version and the precise scope", () => {
  const plan = prepareCalendarMutation(operationId, update, snapshot);
  expect(calendarMutationStateMatches(plan, { ...original, summary: "After" })).toBe(false);
  expect(
    calendarMutationStateMatches(plan, { ...original, summary: "After", etag: '"changed"' }),
  ).toBe(true);
  expect(
    calendarMutationStateMatches(plan, {
      ...original,
      summary: "After",
      etag: '"changed"',
      recurrence: ["RRULE:FREQ=DAILY"],
    }),
  ).toBe(false);
  const instance = { ...original, recurringEventId: "series1", originalStartTime: original.start };
  const scoped = prepareCalendarMutation(
    operationId,
    {
      ...update,
      scope: { kind: "instance", recurringEventId: "series1", originalStartTime: original.start },
    },
    { ...snapshot, event: instance },
  );
  expect(
    calendarMutationStateMatches(scoped, { ...instance, summary: "After", etag: '"changed"' }),
  ).toBe(true);
  expect(
    calendarMutationStateMatches(scoped, {
      ...instance,
      summary: "After",
      etag: '"changed"',
      originalStartTime: { date: "2026-10-02" },
    }),
  ).toBe(false);
});

test("Calendar deletion needs a versioned tombstone, never absence alone", () => {
  const plan = prepareCalendarMutation(
    operationId,
    {
      kind: "delete",
      target,
      sendUpdates: "all",
      eventId: original.id,
      etag: original.etag,
      scope: { kind: "single" },
    },
    snapshot,
  );
  expect(
    calendarMutationStateMatches(plan, { id: original.id, status: "cancelled", etag: '"deleted"' }),
  ).toBe(true);
  for (const value of [
    null,
    {},
    { id: original.id, status: "cancelled" },
    { ...original, status: "cancelled" },
    { ...original, etag: '"active"' },
  ]) {
    expect(calendarMutationStateMatches(plan, value)).toBe(false);
  }
});

test("Calendar reconciliation compares instants across offsets and complete attendee membership", () => {
  const event = {
    ...fields,
    timing: {
      kind: "timed",
      start: "2026-11-01T01:30:00-04:00",
      end: "2026-11-01T01:30:00-05:00",
      timezone: "America/New_York",
    },
    attendees: [{ email: "Guest@example.com", optional: false, displayName: "Guest" }],
  };
  const plan = prepareCalendarMutation(operationId, {
    kind: "create",
    target,
    sendUpdates: "all",
    event,
  });
  const observed = {
    ...plan.body,
    eventType: "default",
    etag: '"new"',
    start: { dateTime: "2026-11-01T05:30:00Z", timeZone: "America/New_York" },
    end: { dateTime: "2026-11-01T06:30:00Z", timeZone: "America/New_York" },
    attendees: [{ email: "guest@example.com", displayName: "Guest", responseStatus: "accepted" }],
  };
  expect(calendarMutationStateMatches(plan, observed)).toBe(true);
  expect(
    calendarMutationStateMatches(plan, {
      ...observed,
      start: { dateTime: "2026-11-01T01:30:00", timeZone: "America/New_York" },
    }),
  ).toBe(false);
  expect(
    calendarMutationStateMatches(plan, {
      ...observed,
      attendees: [{ email: "guest@example.com", displayName: "Guest", optional: true }],
    }),
  ).toBe(false);
  expect(
    calendarMutationStateMatches(plan, {
      ...observed,
      attendees: [{ email: "guest@example.com", displayName: "Different" }],
    }),
  ).toBe(false);
});
