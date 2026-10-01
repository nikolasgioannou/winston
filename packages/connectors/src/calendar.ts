/**
 * The calendar domain's normalized model and adapter interface
 * (docs/design.md §3; §11 `winston calendar`). Google Calendar is the only
 * implementation today. Event ids here are the provider's own
 * (`<calendarId>/<eventId>` for Google); the VM-facing API turns them into
 * `evt_` ids.
 */

export type AttendeeResponse =
  "needs_action" | "accepted" | "declined" | "tentative";

export interface Attendee {
  email: string;
  name: string | null;
  response: AttendeeResponse;
  optional: boolean;
  /** This connection's own address. */
  self: boolean;
}

/** A timed event's instant, or an all-day event's date (`YYYY-MM-DD`, end exclusive). */
export type EventTime = { at: Date } | { date: string };

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  /** Whether this account may add or change events in it. */
  writable: boolean;
  timeZone: string | null;
}

export interface CalendarEvent {
  providerId: string;
  calendarId: string;
  title: string;
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  location: string | null;
  description: string | null;
  organizer: { email: string; name: string | null; self: boolean } | null;
  attendees: Attendee[];
  /** This account's own answer, when it's invited. */
  myResponse: AttendeeResponse | null;
  status: "confirmed" | "tentative" | "cancelled";
  /** A video call link (Meet), when there is one. */
  videoLink: string | null;
  /** RRULE lines for a recurring series; null for single events. */
  recurrence: string[] | null;
  /** The series this occurrence belongs to. */
  seriesId: string | null;
  htmlLink: string | null;
  updatedAt: Date | null;
}

export interface CalendarFilter {
  calendarId?: string | undefined;
  text?: string | undefined;
  attendee?: string | undefined;
  organizer?: string | undefined;
  /** Has attendees outside the account's own domain. */
  external?: boolean | undefined;
  title?: string | undefined;
  since: Date;
  until: Date;
}

export interface NewEvent {
  calendarId?: string | undefined;
  title: string;
  start: EventTime;
  end: EventTime;
  attendees?: string[] | undefined;
  location?: string | undefined;
  description?: string | undefined;
  video?: boolean | undefined;
  /** RRULE lines. */
  recurrence?: string[] | undefined;
  timeZone?: string | undefined;
}

export interface EventChanges extends Partial<
  Omit<NewEvent, "attendees" | "calendarId">
> {
  addAttendees?: string[] | undefined;
  removeAttendees?: string[] | undefined;
}

/** Which occurrences of a recurring series a change applies to. */
export type SeriesScope = "this" | "following" | "all";

export interface BusyBlock {
  start: Date;
  end: Date;
}

export interface CalendarProvider {
  listCalendars(): Promise<CalendarInfo[]>;
  /** Events in the range, earliest first, recurring series expanded. */
  list(
    filter: CalendarFilter,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: CalendarEvent[]; cursor: string | null }>;
  get(eventId: string): Promise<CalendarEvent>;
  /** Busy blocks per address: the account's own calendars and attendees' where visible. */
  freeBusy(input: {
    since: Date;
    until: Date;
    attendees: string[];
  }): Promise<Map<string, BusyBlock[] | "unknown">>;
  create(event: NewEvent, options: { notify: boolean }): Promise<CalendarEvent>;
  update(
    eventId: string,
    changes: EventChanges,
    options: { scope: SeriesScope; notify: boolean },
  ): Promise<CalendarEvent>;
  delete(
    eventId: string,
    options: { scope: SeriesScope; notify: boolean },
  ): Promise<void>;
  rsvp(
    eventId: string,
    response: Exclude<AttendeeResponse, "needs_action">,
    options: { note?: string | undefined; scope: "this" | "all" },
  ): Promise<CalendarEvent>;
  readonly address: string;
}
