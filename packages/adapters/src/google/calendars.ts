import { googleCalendarPageSchema, type GoogleCalendar } from "@winston/contracts/connections";
import { GoogleAccessError } from "./errors";

export async function readGoogleCalendars(accessToken: string, signal: AbortSignal) {
  const calendars: GoogleCalendar[] = [];
  let pageToken: string | undefined;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  try {
    for (let page = 0; page < 10; page += 1) {
      const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
      url.searchParams.set("maxResults", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      });
      if (response.status === 401) throw new GoogleAccessError("reconnect");
      if (!response.ok) throw new GoogleAccessError("unavailable");
      const result = googleCalendarPageSchema.parse(await response.json());
      calendars.push(...(result.items ?? []));
      if (calendars.length > 1000) throw new Error();
      pageToken = result.nextPageToken;
      if (!pageToken) return calendars;
    }
    throw new Error();
  } catch (error) {
    if (error instanceof GoogleAccessError) throw error;
    throw new GoogleAccessError("unavailable");
  }
}
