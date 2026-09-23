import {
  calendarEventPageSchema,
  calendarEventQuerySchema,
  calendarEventRequestSchema,
  calendarProviderEventSchema,
  type CalendarEventQuery,
  type CalendarEventRequest,
} from "@winston/contracts/calendar";
import { canonicalJson } from "@winston/contracts/json";
import {
  createGoogleReadRequest,
  GoogleReadError,
  type GoogleReadFailure,
  type GoogleReadOptions,
} from "./read-request";

export class CalendarReadError extends GoogleReadError {
  constructor(kind: GoogleReadFailure) {
    super(kind, "Calendar");
  }
}

export function createCalendarReader(options: GoogleReadOptions) {
  const request = createGoogleReadRequest(options, {
    service: "calendar",
    error: (kind) => new CalendarReadError(kind),
  });
  return {
    async events(ownerId: string, input: CalendarEventQuery, signal: AbortSignal) {
      const parsed = calendarEventQuerySchema.parse(input);
      if (
        parsed.cursor &&
        (parsed.cursor.connectionId !== parsed.target.connectionId ||
          parsed.cursor.calendarId !== parsed.target.calendarId ||
          canonicalJson(parsed.cursor.window) !== canonicalJson(parsed.window))
      )
        throw new CalendarReadError("stale");
      const query = new URLSearchParams({
        timeMin: parsed.window.timeMin,
        timeMax: parsed.window.timeMax,
        timeZone: parsed.window.timezone,
        maxResults: String(parsed.limit),
        singleEvents: "true",
        showDeleted: "true",
        orderBy: "startTime",
      });
      if (parsed.window.query) query.set("q", parsed.window.query);
      if (parsed.cursor) query.set("pageToken", parsed.cursor.pageToken);
      const result = await request(
        ownerId,
        parsed.target,
        `calendars/${encodeURIComponent(parsed.target.calendarId)}/events`,
        query,
        signal,
      );
      const page = calendarEventPageSchema.safeParse(result.data);
      if (!page.success || page.data.items.length > parsed.limit)
        throw new CalendarReadError("unavailable");
      return {
        source: result.source,
        timezone: page.data.timeZone ?? parsed.window.timezone,
        trust: "untrusted_external_content" as const,
        events: page.data.items,
        cursor: page.data.nextPageToken
          ? {
              connectionId: parsed.target.connectionId,
              calendarId: parsed.target.calendarId,
              window: parsed.window,
              pageToken: page.data.nextPageToken,
            }
          : null,
      };
    },
    async event(ownerId: string, input: CalendarEventRequest, signal: AbortSignal) {
      const parsed = calendarEventRequestSchema.parse(input);
      const result = await request(
        ownerId,
        parsed.target,
        `calendars/${encodeURIComponent(parsed.target.calendarId)}/events/${encodeURIComponent(parsed.id)}`,
        new URLSearchParams(),
        signal,
      );
      const event = calendarProviderEventSchema.safeParse(result.data);
      if (!event.success || event.data.id !== parsed.id) throw new CalendarReadError("unavailable");
      return {
        source: result.source,
        trust: "untrusted_external_content" as const,
        event: event.data,
      };
    },
  };
}
