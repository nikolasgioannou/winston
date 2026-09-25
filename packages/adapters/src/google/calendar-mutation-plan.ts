import {
  calendarMutationArgumentsSchema,
  calendarMutationIntentSchema,
  calendarMutationPlanSchema,
  calendarMutationRequestSchema,
  calendarMutationOperationIdSchema,
  calendarMutationSnapshotSchema,
  type CalendarMutationRequest,
  type CalendarMutationSnapshot,
  type CalendarMutationTiming,
} from "@winston/contracts/calendar-mutations";
import { canonicalJson, type JsonValue } from "@winston/contracts/json";
import { calendarRsvpBody } from "./calendar-rsvp";

type Attendee = CalendarMutationSnapshot["event"]["attendees"][number];

// Rebuild every provider-facing field before trusting a persisted plan's shape.
// This verifies consistency; the durable action supplies the actual authority.
export function readCalendarMutationArguments(input: unknown) {
  const value = calendarMutationArgumentsSchema.parse(input);
  const { plan, intent } = value;
  const { target, ...details } = plan.request;
  const expectedIntent = calendarMutationIntentSchema.parse({
    ...details,
    accountId: target.connectionId,
    calendarId: target.calendarId,
  });
  if (canonicalJson(intent) !== canonicalJson(expectedIntent))
    throw new Error("Calendar plan does not match its requested intent.");
  const rebuilt = prepareCalendarMutation(
    plan.operationId,
    plan.request,
    plan.before
      ? { source: { ...target, operation: "calendar.read" }, event: plan.before }
      : undefined,
  );
  if (canonicalJson(plan) !== canonicalJson(rebuilt))
    throw new Error("Calendar plan does not match its reviewed provider operation.");
  return value;
}

function timingBody(timing: CalendarMutationTiming) {
  const { start, end, timezone } = timing;
  return timing.kind === "all-day"
    ? { start: { date: start, timeZone: timezone }, end: { date: end, timeZone: timezone } }
    : {
        start: { dateTime: start, timeZone: timezone },
        end: { dateTime: end, timeZone: timezone },
      };
}

function fieldsBody(
  fields: Extract<CalendarMutationRequest, { kind: "update" }>["changes"],
  previous: Attendee[] = [],
) {
  const body: Record<string, JsonValue> = {};
  for (const key of ["summary", "description", "location", "recurrence", "transparency"] as const) {
    if (fields[key] !== undefined) body[key] = fields[key];
  }
  if (fields.timing) Object.assign(body, timingBody(fields.timing));
  if (fields.attendees) {
    body.attendees = fields.attendees.map((attendee) => {
      const prior = previous.find(
        (item) => item.email?.toLowerCase() === attendee.email.toLowerCase(),
      );
      // Preserve existing RSVP and guest metadata while changing only explicitly requested fields.
      // Read-only provider fields (self/organizer) never become writable input.
      return {
        ...(prior?.responseStatus ? { responseStatus: prior.responseStatus } : {}),
        ...(prior?.comment !== undefined ? { comment: prior.comment } : {}),
        ...(prior?.additionalGuests !== undefined
          ? { additionalGuests: prior.additionalGuests }
          : {}),
        ...(prior?.resource !== undefined ? { resource: prior.resource } : {}),
        ...(prior?.optional !== undefined ? { optional: prior.optional } : {}),
        ...(prior?.displayName !== undefined ? { displayName: prior.displayName } : {}),
        ...attendee,
      };
    });
  }
  return body;
}

function requireSnapshot(
  request: Exclude<CalendarMutationRequest, { kind: "create" }>,
  input: unknown,
) {
  const snapshot = calendarMutationSnapshotSchema.parse(input);
  const { source, event } = snapshot;
  const target = request.target;
  if (
    source.connectionId !== target.connectionId ||
    source.calendarId !== target.calendarId ||
    source.connectionRevision !== target.connectionRevision ||
    source.preferencesRevision !== target.preferencesRevision ||
    source.task?.id !== target.task?.id ||
    source.task?.revision !== target.task?.revision ||
    event.id !== request.eventId ||
    event.etag !== request.etag
  )
    throw new Error("Calendar event snapshot is stale or belongs to another target.");
  if (
    event.status === "cancelled" ||
    event.locked ||
    event.endTimeUnspecified ||
    event.eventType !== "default" ||
    event.attendeesOmitted
  )
    throw new Error("Calendar event cannot be safely prepared for this mutation.");

  const actualScope = event.recurringEventId
    ? "instance"
    : event.recurrence?.length
      ? "series"
      : "single";
  if (request.scope.kind !== actualScope)
    throw new Error("Calendar recurrence scope does not match the selected event.");
  if (
    request.scope.kind === "instance" &&
    (event.recurringEventId !== request.scope.recurringEventId ||
      !event.originalStartTime ||
      canonicalJson(event.originalStartTime) !== canonicalJson(request.scope.originalStartTime))
  )
    throw new Error("Calendar instance identity does not match the selected occurrence.");
  if (
    request.kind === "update" &&
    request.changes.recurrence !== undefined &&
    actualScope !== "series"
  )
    throw new Error("Changing recurrence requires an explicit whole-series target.");
  if (request.kind === "update" && request.changes.attendees && event.organizer?.self !== true)
    throw new Error("Changing attendees requires the organizer's event copy.");
  return snapshot;
}

// Pure preparation only. The caller must bind this complete plan to an owner-authorized
// action and revalidate its target before dispatch. A plan is never an execution credential.
export function prepareCalendarMutation(operationId: string, input: unknown, snapshot?: unknown) {
  const operation = calendarMutationOperationIdSchema.parse(operationId).toLowerCase();
  const request = calendarMutationRequestSchema.parse(input);
  const base = `calendars/${encodeURIComponent(request.target.calendarId)}/events`;
  const previous = request.kind === "create" ? null : requireSnapshot(request, snapshot);
  const eventId = request.kind === "create" ? operation.replaceAll("-", "") : request.eventId;
  const body: Record<string, JsonValue> | null =
    request.kind === "create"
      ? { id: eventId, ...fieldsBody(request.event) }
      : request.kind === "update"
        ? fieldsBody(request.changes, previous?.event.attendees)
        : request.kind === "rsvp" && previous
          ? calendarRsvpBody(request, previous.event)
          : null;
  const changedAttendees =
    request.kind === "create"
      ? request.event.attendees
      : request.kind === "update"
        ? request.changes.attendees
        : undefined;
  const recipients = new Set(
    [
      ...(previous?.event.attendees.flatMap((item) => (item.email ? [item.email] : [])) ?? []),
      ...(changedAttendees?.map((item) => item.email) ?? []),
      ...(request.kind === "rsvp" && previous?.event.organizer?.email
        ? [previous.event.organizer.email]
        : []),
    ].map((email) => email.toLowerCase()),
  );

  const plan = {
    version: 1 as const,
    operationId: operation,
    request,
    eventId,
    method:
      request.kind === "create"
        ? ("POST" as const)
        : request.kind === "update" || request.kind === "rsvp"
          ? ("PATCH" as const)
          : ("DELETE" as const),
    path: request.kind === "create" ? base : `${base}/${encodeURIComponent(eventId)}`,
    ifMatch: request.kind === "create" ? null : request.etag,
    sendUpdates: request.sendUpdates,
    body,
    before: previous?.event ?? null,
    // externalOnly cannot be inferred from an email domain. Show all potentially affected guests.
    potentialNotificationRecipients: [...recipients].sort(),
  };
  if (Buffer.byteLength(JSON.stringify(plan)) > 100_000)
    throw new Error("Calendar mutation plan is too large to review safely.");
  return calendarMutationPlanSchema.parse(plan);
}
