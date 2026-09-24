import {
  calendarAvailabilityQuerySchema,
  calendarAvailabilityResponseSchema,
  type CalendarAvailabilityQuery,
} from "@winston/contracts/calendar";
import { createGoogleReadRequest, type GoogleReadOptions } from "./read-request";
import { CalendarReadError } from "./calendar-events";

export function createCalendarAvailabilityReader(options: GoogleReadOptions) {
  const request = createGoogleReadRequest(options, {
    service: "calendar",
    error: (kind) => new CalendarReadError(kind),
  });
  return async (ownerId: string, input: CalendarAvailabilityQuery, signal: AbortSignal) => {
    const { target, window } = calendarAvailabilityQuerySchema.parse(input);
    const result = await request(ownerId, target, "freeBusy", new URLSearchParams(), signal, {
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      timeZone: window.timezone,
    });
    const parsed = calendarAvailabilityResponseSchema.safeParse(result.data);
    if (!parsed.success) throw new CalendarReadError("unavailable");
    const response = parsed.data;
    const calendar = response.calendars[target.calendarId];
    if (
      !calendar ||
      calendar.errors?.length ||
      Object.keys(response.calendars).length !== 1 ||
      Object.keys(response.groups ?? {}).length ||
      Date.parse(response.timeMin) !== Date.parse(window.timeMin) ||
      Date.parse(response.timeMax) !== Date.parse(window.timeMax)
    )
      throw new CalendarReadError("unavailable");
    return {
      source: result.source,
      window,
      busy: calendar.busy,
      trust: "untrusted_external_content" as const,
    };
  };
}
