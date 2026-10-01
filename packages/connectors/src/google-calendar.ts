/**
 * Google Calendar's side of `CalendarReader` (docs/design.md §3, §11
 * `winston calendar`), over the Calendar REST API v3.
 *
 * - **Which calendars:** the ones the user has selected (shown) in Google
 *   Calendar, which is what they think of as "my calendar"; the primary
 *   calendar when none is selected. Free/busy-only calendars can't list
 *   events and are skipped. `calendarId` narrows to one.
 * - **Recurring events** are expanded into their occurrences
 *   (`singleEvents=true`), ordered by start, so a list shows what actually
 *   happens in the range. An occurrence knows its series (`seriesId`).
 * - **Ids** are `<calendar id>/<event id>`: an event id is only unique within
 *   its calendar.
 * - **Paging** merges the calendars by start time; the cursor is the start
 *   of the next event plus the ids already shown at that same instant.
 * - **External** means an attendee outside the account's own domain; for a
 *   consumer address (gmail.com and the like), anyone but the user.
 */
import type {
  AttendeeResponse,
  BusyBlock,
  CalendarEvent,
  CalendarInfo,
  CalendarReader,
  EventTime,
} from "./calendar.ts";
import { ProviderNotFoundError, ProviderUnavailableError } from "./errors.ts";

const api = "https://www.googleapis.com/calendar/v3";

/** Domains shared by everyone who uses them: no one there is a colleague. */
const publicDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
]);

export interface GoogleCalendarOptions {
  address: string;
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
}

// Google's JSON, as far as it's read here.
export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: {
    email: string;
    displayName?: string;
    responseStatus?: string;
    optional?: boolean;
    self?: boolean;
    resource?: boolean;
  }[];
  organizer?: { email: string; displayName?: string; self?: boolean };
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
  recurrence?: string[];
  recurringEventId?: string;
  htmlLink?: string;
  updated?: string;
}

const responses: Record<string, AttendeeResponse> = {
  needsAction: "needs_action",
  accepted: "accepted",
  declined: "declined",
  tentative: "tentative",
};

const timeOf = (time: GoogleEvent["start"]): EventTime =>
  time?.date ? { date: time.date } : { at: new Date(time?.dateTime ?? 0) };

/** When an event starts, as an instant, for sorting and paging. */
export const startInstant = (event: CalendarEvent, timeZone = "UTC") =>
  "at" in event.start
    ? event.start.at
    : new Date(
        Temporal.PlainDate.from(event.start.date)
          .toZonedDateTime({ timeZone })
          .toInstant().epochMilliseconds,
      );

/** Whether anyone on the event is from outside the account's own domain. */
export function isExternal(event: CalendarEvent, self: string) {
  const domain = self.split("@")[1]?.toLowerCase() ?? "";
  const others = event.attendees.filter(
    (a) => !a.self && a.email.toLowerCase() !== self.toLowerCase(),
  );
  if (publicDomains.has(domain)) return others.length > 0;
  return others.some((a) => a.email.split("@")[1]?.toLowerCase() !== domain);
}

export function toCalendarEvent(
  calendarId: string,
  event: GoogleEvent,
  self: string,
): CalendarEvent {
  const attendees = (event.attendees ?? [])
    .filter((a) => !a.resource)
    .map((a) => ({
      email: a.email.toLowerCase(),
      name: a.displayName ?? null,
      response: responses[a.responseStatus ?? "needsAction"] ?? "needs_action",
      optional: a.optional === true,
      self: a.self === true || a.email.toLowerCase() === self.toLowerCase(),
    }));
  const video =
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")
      ?.uri ??
    null;
  return {
    providerId: `${calendarId}/${event.id}`,
    calendarId,
    title: event.summary ?? "(no title)",
    start: timeOf(event.start),
    end: timeOf(event.end),
    allDay: event.start?.date !== undefined,
    location: event.location ?? null,
    description: event.description ?? null,
    organizer: event.organizer
      ? {
          email: event.organizer.email.toLowerCase(),
          name: event.organizer.displayName ?? null,
          self: event.organizer.self === true,
        }
      : null,
    attendees,
    myResponse: attendees.find((a) => a.self)?.response ?? null,
    status:
      event.status === "cancelled"
        ? "cancelled"
        : event.status === "tentative"
          ? "tentative"
          : "confirmed",
    videoLink: video,
    recurrence: event.recurrence ?? null,
    seriesId: event.recurringEventId
      ? `${calendarId}/${event.recurringEventId}`
      : null,
    htmlLink: event.htmlLink ?? null,
    updatedAt: event.updated ? new Date(event.updated) : null,
  };
}

/** Splits `<calendar>/<event>`; calendar ids contain `@` but never `/`. */
export function splitEventId(id: string) {
  const at = id.indexOf("/");
  if (at <= 0) throw new ProviderNotFoundError(`${id} isn't a calendar event.`);
  return { calendarId: id.slice(0, at), eventId: id.slice(at + 1) };
}

interface CalendarEntry extends CalendarInfo {
  /** Shown in Google Calendar: what the user thinks of as their calendar. */
  selected: boolean;
  /** Events can be listed (not free/busy only). */
  readable: boolean;
}

interface Cursor {
  /** The start of the next event to show. */
  after: string;
  /** Events at exactly that instant already shown. */
  shown: string[];
}

export function googleCalendarReader({
  address,
  accessToken,
  fetch: send = fetch,
}: GoogleCalendarOptions): CalendarReader {
  async function call<T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      query?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = new URL(`${api}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {}))
      url.searchParams.set(key, value);
    const response = await send(url.href, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (response.status === 404 || response.status === 410)
      throw new ProviderNotFoundError(
        "Google Calendar has no such event (it may have been deleted).",
      );
    if (response.status === 429 || response.status >= 500)
      throw new ProviderUnavailableError(
        `Google Calendar is busy (${String(response.status)}).`,
      );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new Error(
        `Google Calendar said ${String(response.status)}: ${body.error?.message ?? "no details"}`,
      );
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** The account's calendars, with what decides which ones a list covers. */
  const calendars = async (): Promise<CalendarEntry[]> => {
    const { items = [] } = await call<{
      items?: {
        id: string;
        summary?: string;
        summaryOverride?: string;
        primary?: boolean;
        accessRole?: string;
        selected?: boolean;
        timeZone?: string;
      }[];
    }>("/users/me/calendarList", {
      query: { minAccessRole: "freeBusyReader" },
    });
    return items.map((c) => ({
      id: c.id,
      name: c.summaryOverride ?? c.summary ?? c.id,
      primary: c.primary === true,
      writable: c.accessRole === "owner" || c.accessRole === "writer",
      timeZone: c.timeZone ?? null,
      selected: c.selected === true,
      readable: c.accessRole !== "freeBusyReader",
    }));
  };

  return {
    address,

    async listCalendars() {
      return (await calendars()).map((c): CalendarInfo => ({
        id: c.id,
        name: c.name,
        primary: c.primary,
        writable: c.writable,
        timeZone: c.timeZone,
      }));
    },

    async list(filter, { limit, cursor }) {
      const all = await calendars();
      const readable = all.filter((c) => c.readable);
      const chosen = filter.calendarId
        ? readable.filter(
            (c) =>
              c.id === filter.calendarId ||
              c.name.toLowerCase() === filter.calendarId?.toLowerCase(),
          )
        : readable.filter((c) => c.selected);
      const targets =
        chosen.length > 0 ? chosen : readable.filter((c) => c.primary);
      if (filter.calendarId && chosen.length === 0)
        throw new ProviderNotFoundError(
          `No calendar is called ${filter.calendarId}. The calendars are: ${readable.map((c) => c.name).join(", ")}.`,
        );
      const position = cursor
        ? (JSON.parse(Buffer.from(cursor, "base64url").toString()) as Cursor)
        : undefined;
      const timeMin = position ? new Date(position.after) : filter.since;
      const perCalendar = await Promise.all(
        targets.map(async (calendar) => {
          const query: Record<string, string> = {
            singleEvents: "true",
            orderBy: "startTime",
            timeMin: timeMin.toISOString(),
            timeMax: filter.until.toISOString(),
            maxResults: String(
              Math.min(250, limit + (position?.shown.length ?? 0) + 1),
            ),
          };
          if (filter.text) query.q = filter.text;
          const { items = [] } = await call<{ items?: GoogleEvent[] }>(
            `/calendars/${encodeURIComponent(calendar.id)}/events`,
            { query },
          );
          return items
            .filter((e) => e.status !== "cancelled")
            .map((e) => toCalendarEvent(calendar.id, e, address));
        }),
      );
      const wanted = (event: CalendarEvent) =>
        (!filter.attendee ||
          event.attendees.some(
            (a) =>
              a.email.includes(filter.attendee?.toLowerCase() ?? "") ||
              (a.name ?? "")
                .toLowerCase()
                .includes(filter.attendee?.toLowerCase() ?? ""),
          )) &&
        (!filter.organizer ||
          (event.organizer?.email.includes(filter.organizer.toLowerCase()) ??
            false) ||
          (event.organizer?.name ?? "")
            .toLowerCase()
            .includes(filter.organizer.toLowerCase())) &&
        (!filter.title ||
          event.title.toLowerCase().includes(filter.title.toLowerCase())) &&
        (filter.external === undefined ||
          isExternal(event, address) === filter.external) &&
        !(
          position &&
          startInstant(event).getTime() ===
            new Date(position.after).getTime() &&
          position.shown.includes(event.providerId)
        );
      const merged = perCalendar
        .flat()
        .filter(wanted)
        .sort((a, b) => startInstant(a).getTime() - startInstant(b).getTime());
      const items = merged.slice(0, limit);
      const next = merged[limit];
      let nextCursor: string | null = null;
      if (next) {
        const after = startInstant(next).toISOString();
        const shown = items
          .filter((e) => startInstant(e).toISOString() === after)
          .map((e) => e.providerId);
        nextCursor = Buffer.from(
          JSON.stringify({ after, shown } satisfies Cursor),
        ).toString("base64url");
      }
      return { items, cursor: nextCursor };
    },

    async get(id) {
      const { calendarId, eventId } = splitEventId(id);
      const event = await call<GoogleEvent>(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
      return toCalendarEvent(calendarId, event, address);
    },

    async freeBusy({ since, until, attendees }) {
      // The user's own time: their readable calendars (a selected free/busy-
      // only calendar is someone else's).
      const own = (await calendars()).filter(
        (c) => c.primary || (c.selected && c.readable),
      );
      const items = [
        ...own.map((c) => c.id),
        ...attendees.filter((a) => !own.some((c) => c.id === a)),
      ];
      const result = await call<{
        calendars?: Record<
          string,
          { busy?: { start: string; end: string }[]; errors?: unknown[] }
        >;
      }>("/freeBusy", {
        method: "POST",
        body: {
          timeMin: since.toISOString(),
          timeMax: until.toISOString(),
          items: items.map((id) => ({ id })),
        },
      });
      const blocks = (id: string): BusyBlock[] | "unknown" => {
        const calendar = result.calendars?.[id];
        if (!calendar || calendar.errors?.length) return "unknown";
        return (calendar.busy ?? []).map((b) => ({
          start: new Date(b.start),
          end: new Date(b.end),
        }));
      };
      // The user's own calendars together, under their address.
      const mine = own.flatMap((c) => {
        const busy = blocks(c.id);
        return busy === "unknown" ? [] : busy;
      });
      const out = new Map<string, BusyBlock[] | "unknown">([[address, mine]]);
      for (const attendee of attendees) out.set(attendee, blocks(attendee));
      return out;
    },
  };
}
