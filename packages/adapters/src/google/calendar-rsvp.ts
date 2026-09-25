import type {
  CalendarMutationRequest,
  CalendarMutationSnapshot,
} from "@winston/contracts/calendar-mutations";

type Rsvp = Extract<CalendarMutationRequest, { kind: "rsvp" }>;
export function calendarRsvpAttendee(request: Rsvp, event: CalendarMutationSnapshot["event"]) {
  const self = event.attendees.filter((attendee) => attendee.self === true);
  const attendee = self[0];
  const email = request.target.email.toLowerCase();
  if (
    self.length !== 1 ||
    !attendee?.email ||
    attendee.email.toLowerCase() !== email ||
    event.attendees.filter((guest) => guest.email?.toLowerCase() === email).length !== 1 ||
    attendee.organizer === true ||
    event.organizer?.self === true ||
    !event.organizer?.email ||
    event.organizer.email.toLowerCase() === email
  )
    throw new Error(
      "RSVP requires the selected account's unambiguous attendee copy of an invitation.",
    );
  return { ...attendee, email: attendee.email };
}

export function calendarRsvpBody(request: Rsvp, event: CalendarMutationSnapshot["event"]) {
  const attendee = calendarRsvpAttendee(request, event);
  if (attendee.responseStatus === request.response)
    throw new Error("The selected attendee already has this response.");
  // Google documents attendeesOmitted for changing only the participant's response.
  return {
    attendeesOmitted: true,
    attendees: [{ email: attendee.email, responseStatus: request.response }],
  };
}

export function calendarRsvpMatches(request: Rsvp, event: CalendarMutationSnapshot["event"]) {
  try {
    return calendarRsvpAttendee(request, event).responseStatus === request.response;
  } catch {
    return false;
  }
}
