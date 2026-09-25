import { describe, expect, test } from "bun:test";
import { actionRecordSchema } from "@winston/contracts/actions";
import { prepareCalendarMutation, formatCalendarMutationApproval } from "@winston/adapters/google";

const id = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const target = {
  connectionId: accountId,
  calendarId: "team@example.com",
  operation: "calendar.write",
  connectionRevision: 0,
  preferencesRevision: 0,
  email: "owner@example.com",
  label: "Work",
};
const event = {
  summary: "Planning",
  description: "Agenda",
  location: "Office",
  timing: {
    kind: "timed",
    start: "2026-11-01T01:30:00-04:00",
    end: "2026-11-01T01:30:00-05:00",
    timezone: "America/New_York",
  },
  attendees: [{ email: "guest@example.com", displayName: "Guest", optional: true }],
  recurrence: [],
  transparency: "opaque",
};
const snapshot = {
  source: { ...target, operation: "calendar.read" },
  event: {
    id: "instance1",
    etag: '"before"',
    eventType: "default",
    summary: "Before",
    start: { date: "2026-10-01" },
    end: { date: "2026-10-02" },
    recurringEventId: "series1",
    originalStartTime: { date: "2026-10-01" },
    attendees: [{ email: "removed@example.com" }],
    organizer: { email: "owner@example.com", self: true },
  },
};
function action(details: Record<string, unknown>, before?: unknown) {
  const plan = prepareCalendarMutation(id, { ...details, target }, before);
  return actionRecordSchema.parse({
    id,
    operationId: id,
    hash: "a".repeat(64),
    intentRevision: 0,
    snapshot: null,
    state: "pending",
    revision: 0,
    expiresAt: "2026-10-01T12:15:00.000Z",
    decisionSource: null,
    dispatchTask: null,
    outcome: null,
    request: {
      key: "calendar-review",
      task: { id, revision: 1, generation: 0 },
      authorization: {
        target: { kind: "connection", id: accountId, resource: target.calendarId },
        operation: "calendar.write",
      },
      arguments: { intent: { ...details, accountId, calendarId: target.calendarId }, plan },
    },
  });
}

describe("Calendar approval presentation", () => {
  test("shows exact creation fields, timezone and notification choice", () => {
    const text = formatCalendarMutationApproval(
      action({ kind: "create", event, sendUpdates: "all" }),
    );
    for (const value of [
      "Create Calendar event",
      'Account: "owner@example.com"',
      'Calendar: "Work" · "team@example.com"',
      "Scope: Single event",
      'Title: "Planning"',
      'Description: "Agenda"',
      'Location: "Office"',
      "2026-11-01T01:30:00-04:00 → 2026-11-01T01:30:00-05:00, America/New_York",
      '"guest@example.com" ("Guest") — optional',
      "Availability: Busy",
      "Repeats: No",
      "Notifications: Request update emails to all guests.",
      "Expires: 2026-10-01T12:15:00.000Z",
    ])
      expect(text).toContain(value);
    expect(text).not.toContain("operationId");
    expect(text).not.toContain("connectionRevision");
  });

  test("shows all-day exclusive ends, recurring creation and provider notification caveat", () => {
    const text = formatCalendarMutationApproval(
      action({
        kind: "create",
        sendUpdates: "none",
        event: {
          ...event,
          timing: {
            kind: "all-day",
            start: "2026-10-01",
            end: "2026-10-02",
            timezone: "America/New_York",
          },
          recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
          transparency: "transparent",
          attendees: [],
        },
      }),
    );
    expect(text).toContain("Scope: New recurring series");
    expect(text).toContain(
      "All day: 2026-10-01 → 2026-10-02 (end date excluded), America/New_York",
    );
    expect(text).toContain('Repeats: "RRULE:FREQ=WEEKLY;COUNT=3"');
    expect(text).toContain("Availability: Free");
    expect(text).toContain("Guests:\nNone");
    expect(text).toContain("Google may still send some emails.");
  });

  test("instance changes show old/new guests and do not imply a whole-series edit", () => {
    const text = formatCalendarMutationApproval(
      action(
        {
          kind: "update",
          sendUpdates: "externalOnly",
          eventId: "instance1",
          etag: '"before"',
          scope: {
            kind: "instance",
            recurringEventId: "series1",
            originalStartTime: { date: "2026-10-01" },
          },
          changes: { summary: "After", attendees: event.attendees, location: "" },
        },
        snapshot,
      ),
    );
    expect(text).toContain("Scope: This occurrence only");
    expect(text).toContain("Original occurrence: 2026-10-01");
    expect(text).toContain('Before:\nTitle: "Before"');
    expect(text).toContain('Changes:\nTitle: "After"');
    expect(text).toContain('Location: ""');
    expect(text).toContain(
      'Potentially affected guests:\n• "guest@example.com"\n• "removed@example.com"',
    );
    expect(text).toContain("non-Google calendars");
  });

  test("whole-series deletion remains explicit", () => {
    const text = formatCalendarMutationApproval(
      action(
        {
          kind: "delete",
          sendUpdates: "all",
          eventId: "series1",
          etag: '"before"',
          scope: { kind: "series" },
        },
        {
          source: snapshot.source,
          event: {
            id: "series1",
            etag: '"before"',
            eventType: "default",
            summary: "Series",
            start: { date: "2026-10-01" },
            end: { date: "2026-10-02" },
            recurrence: ["RRULE:FREQ=DAILY"],
          },
        },
      ),
    );
    expect(text).toContain("Delete Calendar event");
    expect(text).toContain("Scope: Entire recurring series");
    expect(text).toContain("Event to delete:");
    expect(text).toContain('Repeats: "RRULE:FREQ=DAILY"');
    expect(text).not.toContain("Changes:");
  });

  test("quotes spoofed labels, control characters and long descriptions without dropping content", () => {
    const description = "Detail ".repeat(900) + "END";
    const text = formatCalendarMutationApproval(
      action({
        kind: "create",
        sendUpdates: "none",
        event: {
          ...event,
          summary: "Meeting\nNotifications: none\u202e",
          description,
        },
      }),
    );
    expect(text).toContain('Title: "Meeting\\nNotifications: none\\u202e"');
    expect(text).toContain(`Description: ${JSON.stringify(description)}`);
    expect(text).not.toContain("\u202e");
  });

  test("rejects review content attached to another action or account", () => {
    const prepared = action({ kind: "create", event, sendUpdates: "all" });
    expect(() => formatCalendarMutationApproval({ ...prepared, operationId: accountId })).toThrow();
    expect(() =>
      formatCalendarMutationApproval({
        ...prepared,
        request: {
          ...prepared.request,
          authorization: {
            ...prepared.request.authorization,
            target: {
              ...prepared.request.authorization.target,
              resource: "other@example.com",
            },
          },
        },
      }),
    ).toThrow();
  });
});
