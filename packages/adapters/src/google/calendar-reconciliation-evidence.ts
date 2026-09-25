import { calendarProviderEventSchema, calendarEventTimeSchema } from "@winston/contracts/calendar";
import {
  calendarMutationPlanSchema,
  calendarMutationEtagSchema,
  type CalendarMutationPlan,
} from "@winston/contracts/calendar-mutations";
import { canonicalJson } from "@winston/contracts/json";
import { calendarRsvpMatches } from "./calendar-rsvp";

function sameTime(expected: unknown, observed: unknown) {
  const left = calendarEventTimeSchema.safeParse(expected);
  const right = calendarEventTimeSchema.safeParse(observed);
  if (!left.success || !right.success) return false;
  if ("date" in left.data) return "date" in right.data && left.data.date === right.data.date;
  if (!("dateTime" in right.data)) return false;
  const leftInstant = Date.parse(left.data.dateTime);
  const rightInstant = Date.parse(right.data.dateTime);
  // Local wall times without offsets are insufficient evidence across DST transitions.
  const offset = /(?:Z|[+-]\d{2}:\d{2})$/;
  return (
    offset.test(left.data.dateTime) &&
    offset.test(right.data.dateTime) &&
    Number.isFinite(leftInstant) &&
    leftInstant === rightInstant &&
    (!left.data.timeZone || left.data.timeZone === right.data.timeZone)
  );
}

// This proves the desired state was observed, not who changed it or whether guests received mail.
export function calendarMutationStateMatches(inputPlan: CalendarMutationPlan, inputEvent: unknown) {
  const plan = calendarMutationPlanSchema.parse(inputPlan);
  const parsed = calendarProviderEventSchema.safeParse(inputEvent);
  if (!parsed.success) return false;
  const event = parsed.data;
  if (
    event.id !== plan.eventId ||
    !calendarMutationEtagSchema.safeParse(event.etag).success ||
    event.etag === plan.ifMatch
  )
    return false;
  if (plan.request.kind === "delete") return event.status === "cancelled";
  if (
    event.status === "cancelled" ||
    event.eventType !== "default" ||
    event.attendeesOmitted ||
    event.endTimeUnspecified
  )
    return false;
  const fields =
    plan.request.kind === "create"
      ? plan.request.event
      : plan.request.kind === "update"
        ? plan.request.changes
        : {};
  const scope = plan.request.kind === "create" ? null : plan.request.scope;
  if (scope?.kind === "instance") {
    if (
      event.recurringEventId !== scope.recurringEventId ||
      !sameTime(scope.originalStartTime, event.originalStartTime)
    )
      return false;
  } else if (event.recurringEventId) return false;
  const expectedRecurrence = fields.recurrence ?? plan.before?.recurrence ?? [];
  if (canonicalJson(event.recurrence ?? []) !== canonicalJson(expectedRecurrence)) return false;
  if (plan.request.kind === "rsvp") return calendarRsvpMatches(plan.request, event);
  for (const key of ["summary", "description", "location"] as const) {
    if (fields[key] !== undefined && fields[key] !== (event[key] ?? "")) return false;
  }
  if (fields.transparency !== undefined && fields.transparency !== event.transparency) return false;
  if (fields.timing) {
    const time = fields.timing;
    const start =
      time.kind === "all-day"
        ? { date: time.start }
        : { dateTime: time.start, timeZone: time.timezone };
    const end =
      time.kind === "all-day"
        ? { date: time.end }
        : { dateTime: time.end, timeZone: time.timezone };
    if (!sameTime(start, event.start) || !sameTime(end, event.end)) return false;
  }
  if (fields.attendees) {
    if (event.attendees.length !== fields.attendees.length) return false;
    const emails = event.attendees.map((guest) => guest.email?.toLowerCase());
    if (emails.some((email) => !email) || new Set(emails).size !== emails.length) return false;
    for (const guest of fields.attendees) {
      const found = event.attendees.find(
        (item) => item.email?.toLowerCase() === guest.email.toLowerCase(),
      );
      if (
        !found ||
        (guest.displayName !== undefined && found.displayName !== guest.displayName) ||
        (guest.optional !== undefined && (found.optional ?? false) !== guest.optional)
      )
        return false;
    }
  }
  return true;
}
