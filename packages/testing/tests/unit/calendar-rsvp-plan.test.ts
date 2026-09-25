import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  prepareCalendarMutation,
  calendarMutationStateMatches,
  readCalendarMutationArguments,
} from "@winston/adapters/google";

const accountId = "9cbd0d78-55a2-4885-bb6e-c4e112f2c988";
const operationId = "219fb112-6f15-4c18-b282-b0e0c5a205d7";
const target = {
  connectionId: accountId,
  calendarId: "me@example.com",
  connectionRevision: 0,
  preferencesRevision: 0,
  label: "Personal",
  email: "me@example.com",
  operation: "calendar.write" as const,
};
const source = { ...target, operation: "calendar.read" as const };
const event = {
  id: "event1",
  etag: '"before"',
  eventType: "default",
  summary: "Invitation",
  start: { date: "2026-10-01" },
  end: { date: "2026-10-02" },
  organizer: { email: "host@example.com" },
  attendees: [
    {
      email: "me@example.com",
      self: true,
      responseStatus: "needsAction",
      optional: true,
      comment: "Existing comment",
    },
    { email: "guest@example.com", responseStatus: "accepted" },
  ],
};
const request = {
  kind: "rsvp" as const,
  target,
  eventId: event.id,
  etag: event.etag,
  scope: { kind: "single" as const },
  sendUpdates: "all" as const,
  response: "accepted" as const,
};
test("Calendar RSVP modifies only the selected account participant and verifies its response", () => {
  const plan = prepareCalendarMutation(operationId, request, { source, event });
  assert.equal(plan.method, "PATCH");
  assert.equal(plan.ifMatch, event.etag);
  assert.deepEqual(plan.body, {
    attendeesOmitted: true,
    attendees: [{ email: "me@example.com", responseStatus: "accepted" }],
  });
  assert.ok(plan.potentialNotificationRecipients.includes("host@example.com"));
  const intent = {
    kind: request.kind,
    accountId,
    calendarId: target.calendarId,
    eventId: request.eventId,
    etag: request.etag,
    scope: request.scope,
    sendUpdates: request.sendUpdates,
    response: request.response,
  };
  assert.deepEqual(readCalendarMutationArguments({ intent, plan }).plan, plan);
  assert.throws(() =>
    readCalendarMutationArguments({
      intent,
      plan: { ...plan, body: { ...plan.body, attendeesOmitted: false } },
    }),
  );
  const observed = {
    ...event,
    etag: '"after"',
    attendees: event.attendees.map((attendee) => ({
      ...attendee,
      ...(attendee.self ? { responseStatus: "accepted" } : {}),
    })),
  };
  assert.equal(calendarMutationStateMatches(plan, observed), true);
  for (const changed of [
    { attendees: event.attendees },
    { etag: event.etag },
    { attendeesOmitted: true },
    { attendees: observed.attendees.map((attendee) => ({ ...attendee, self: false })) },
    {
      attendees: observed.attendees.map((attendee) => ({
        ...attendee,
        ...(attendee.self ? { email: "other@example.com" } : {}),
      })),
    },
  ])
    assert.equal(calendarMutationStateMatches(plan, { ...observed, ...changed }), false);
});

test("RSVP rejects ambiguous, foreign, organizer and stale invitation snapshots", () => {
  for (const changed of [
    { attendees: [] },
    { attendees: [...event.attendees, event.attendees[0]] },
    { organizer: { email: "me@example.com", self: true } },
    {
      attendees: event.attendees.map((attendee) => ({
        ...attendee,
        ...(attendee.self ? { organizer: true } : {}),
      })),
    },
    { attendees: event.attendees.map((attendee) => ({ ...attendee, self: false })) },
    {
      attendees: event.attendees.map((attendee) => ({
        ...attendee,
        ...(attendee.self ? { email: "other@example.com" } : {}),
      })),
    },
    {
      attendees: event.attendees.map((attendee) => ({
        ...attendee,
        ...(attendee.self ? { responseStatus: "accepted" } : {}),
      })),
    },
    { etag: '"changed"' },
    { attendeesOmitted: true },
    { status: "cancelled" },
  ])
    assert.throws(() =>
      prepareCalendarMutation(operationId, request, { source, event: { ...event, ...changed } }),
    );
  const recurring = { ...event, recurrence: ["RRULE:FREQ=WEEKLY"] };
  assert.throws(() => prepareCalendarMutation(operationId, request, { source, event: recurring }));
  assert.equal(
    prepareCalendarMutation(
      operationId,
      { ...request, scope: { kind: "series" } },
      { source, event: recurring },
    ).method,
    "PATCH",
  );
  const instance = { ...event, recurringEventId: "series1", originalStartTime: event.start };
  assert.equal(
    prepareCalendarMutation(
      operationId,
      {
        ...request,
        scope: { kind: "instance", recurringEventId: "series1", originalStartTime: event.start },
      },
      { source, event: instance },
    ).eventId,
    event.id,
  );
  assert.throws(() =>
    prepareCalendarMutation(
      operationId,
      {
        ...request,
        scope: {
          kind: "instance",
          recurringEventId: "series1",
          originalStartTime: { date: "2026-10-02" },
        },
      },
      { source, event: instance },
    ),
  );
});
