import type { ActionRecord } from "@winston/contracts/actions";
import type {
  CalendarMutationRequest,
  CalendarMutationSnapshot,
  CalendarMutationTiming,
} from "@winston/contracts/calendar-mutations";
import { readCalendarMutationArguments } from "./calendar-mutation-plan";

// Keep provider/user text visibly inside a quoted value, including directional controls.
function quote(value: string) {
  return JSON.stringify(value).replace(
    /[\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function timing(value: CalendarMutationTiming) {
  return value.kind === "all-day"
    ? `All day: ${value.start} → ${value.end} (end date excluded), ${value.timezone}`
    : `Time: ${value.start} → ${value.end}, ${value.timezone}`;
}

type Fields = Extract<CalendarMutationRequest, { kind: "update" }>["changes"];
function fields(value: Fields) {
  const lines: string[] = [];
  if (value.summary !== undefined) lines.push(`Title: ${quote(value.summary)}`);
  if (value.description !== undefined) lines.push(`Description: ${quote(value.description)}`);
  if (value.location !== undefined) lines.push(`Location: ${quote(value.location)}`);
  if (value.timing) lines.push(timing(value.timing));
  if (value.attendees) {
    lines.push("Guests:");
    lines.push(
      ...(value.attendees.length
        ? value.attendees.map(
            (guest) =>
              `• ${quote(guest.email)}${guest.displayName ? ` (${quote(guest.displayName)})` : ""}${guest.optional ? " — optional" : ""}`,
          )
        : ["None"]),
    );
  }
  if (value.recurrence)
    lines.push(
      `Repeats: ${value.recurrence.length ? value.recurrence.map(quote).join(", ") : "No"}`,
    );
  if (value.transparency)
    lines.push(`Availability: ${value.transparency === "opaque" ? "Busy" : "Free"}`);
  return lines;
}

function previous(value: CalendarMutationSnapshot["event"]) {
  const time = (input: typeof value.start) => {
    if (!input) return "Unspecified";
    return `${"date" in input ? input.date : input.dateTime}${input.timeZone ? ` (${input.timeZone})` : ""}`;
  };
  return [
    `Title: ${quote(value.summary ?? "")}`,
    `Description: ${quote(value.description ?? "")}`,
    `Location: ${quote(value.location ?? "")}`,
    `${value.start && "date" in value.start ? "All day" : "Time"}: ${time(value.start)} → ${time(value.end)}${value.start && "date" in value.start ? " (end date excluded)" : ""}`,
    "Guests:",
    ...(value.attendees.length
      ? value.attendees.map(
          (guest) =>
            `• ${quote(guest.email ?? "")}${guest.displayName ? ` (${quote(guest.displayName)})` : ""}${guest.optional ? " — optional" : ""}`,
        )
      : ["None"]),
    `Repeats: ${value.recurrence?.length ? value.recurrence.map(quote).join(", ") : "No"}`,
    `Availability: ${value.transparency === "opaque" ? "Busy" : "Free"}`,
  ];
}

export function formatCalendarMutationApproval(action: ActionRecord) {
  const { plan } = readCalendarMutationArguments(action.request.arguments);
  const request = plan.request;
  const target = action.request.authorization.target;
  if (
    action.request.authorization.operation !== "calendar.write" ||
    target.kind !== "connection" ||
    target.id !== request.target.connectionId ||
    target.resource !== request.target.calendarId ||
    action.operationId !== plan.operationId
  )
    throw new Error("Calendar review does not match its action.");
  const scope =
    request.kind === "create"
      ? request.event.recurrence.length
        ? "New recurring series"
        : "Single event"
      : request.scope.kind === "series"
        ? "Entire recurring series"
        : request.scope.kind === "instance"
          ? "This occurrence only"
          : "Single event";
  const lines = [
    "Approval needed",
    request.kind === "create"
      ? "Create Calendar event"
      : request.kind === "update"
        ? "Update Calendar event"
        : "Delete Calendar event",
    `Account: ${quote(request.target.email)}`,
    `Calendar: ${quote(request.target.label)} · ${quote(request.target.calendarId)}`,
    `Scope: ${scope}`,
  ];
  if (request.kind !== "create") {
    lines.push(`Event: ${quote(plan.eventId)}`);
    if (request.scope.kind === "instance") {
      const original = request.scope.originalStartTime;
      lines.push(
        `Original occurrence: ${"date" in original ? original.date : original.dateTime}${original.timeZone ? ` (${original.timeZone})` : ""}`,
      );
    }
  }
  if (plan.before)
    lines.push(
      "",
      request.kind === "delete" ? "Event to delete:" : "Before:",
      ...previous(plan.before),
    );
  if (request.kind === "create") lines.push("", ...fields(request.event));
  if (request.kind === "update") lines.push("", "Changes:", ...fields(request.changes));
  const notifications = {
    all: "Request update emails to all guests.",
    externalOnly: "Request update emails only to guests using non-Google calendars.",
    none: "Do not request guest update emails. Google may still send some emails.",
  };
  lines.push("", `Notifications: ${notifications[request.sendUpdates]}`);
  if (plan.potentialNotificationRecipients.length)
    lines.push(
      "Potentially affected guests:",
      ...plan.potentialNotificationRecipients.map((email) => `• ${quote(email)}`),
    );
  lines.push(`Expires: ${action.expiresAt}`);
  return lines.join("\n");
}
