import { describe, expect, test } from "bun:test";
import type { CalendarEvent } from "./calendar.ts";
import { ProviderNotFoundError } from "./errors.ts";
import {
  googleCalendarReader,
  isExternal,
  splitEventId,
  startInstant,
  toCalendarEvent,
  type GoogleEvent,
} from "./google-calendar.ts";

/*
 * Synthetic Calendar API v3 responses, shaped like the real ones: occurrences
 * of a recurring series carry recurringEventId, all-day events have `date`,
 * and resources (rooms) appear among attendees.
 */
const standup = (day: string): GoogleEvent => ({
  id: `standup_${day.replaceAll("-", "")}T140000Z`,
  status: "confirmed",
  summary: "Standup",
  start: { dateTime: `${day}T10:00:00-04:00`, timeZone: "America/New_York" },
  end: { dateTime: `${day}T10:15:00-04:00`, timeZone: "America/New_York" },
  recurringEventId: "standup",
  organizer: { email: "me@acme.com", self: true },
  attendees: [
    { email: "me@acme.com", self: true, responseStatus: "accepted" },
    { email: "sam@acme.com", responseStatus: "accepted" },
  ],
});

const danaSync: GoogleEvent = {
  id: "dana-sync",
  status: "confirmed",
  summary: "Sync with Dana",
  location: "Café",
  description: "Lease",
  start: { dateTime: "2026-09-29T15:00:00-04:00" },
  end: { dateTime: "2026-09-29T15:30:00-04:00" },
  organizer: { email: "dana@example.com", displayName: "Dana Reyes" },
  attendees: [
    {
      email: "Dana@Example.com",
      displayName: "Dana Reyes",
      responseStatus: "accepted",
    },
    { email: "me@acme.com", self: true, responseStatus: "needsAction" },
    {
      email: "room-4@resource.calendar.google.com",
      resource: true,
      responseStatus: "accepted",
    },
  ],
  conferenceData: {
    entryPoints: [
      { entryPointType: "video", uri: "https://meet.google.com/abc" },
    ],
  },
  htmlLink: "https://calendar.google.com/event?eid=x",
};

const primaryEvents: GoogleEvent[] = [
  standup("2026-09-29"),
  danaSync,
  {
    id: "gone",
    status: "cancelled",
    start: { dateTime: "2026-09-29T16:00:00Z" },
    end: { dateTime: "2026-09-29T17:00:00Z" },
  },
  standup("2026-09-30"),
];

const tripEvent: GoogleEvent = {
  id: "trip",
  summary: "Trip",
  start: { date: "2026-09-30" },
  end: { date: "2026-10-02" },
};
const familyEvents: GoogleEvent[] = [tripEvent];

function fakeCalendar() {
  const requests: string[] = [];
  const respond = (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace("/calendar/v3", "");
    requests.push(`${init?.method ?? "GET"} ${path}${url.search}`);
    const json = (value: unknown) => Response.json(value);
    if (path === "/users/me/calendarList")
      return json({
        items: [
          {
            id: "me@acme.com",
            summary: "me@acme.com",
            primary: true,
            selected: true,
            accessRole: "owner",
            timeZone: "America/New_York",
          },
          {
            id: "family123@group.calendar.google.com",
            summary: "Family",
            selected: true,
            accessRole: "writer",
          },
          {
            id: "holidays@group.v.calendar.google.com",
            summary: "Holidays",
            selected: false,
            accessRole: "reader",
          },
          {
            id: "boss@acme.com",
            summary: "Boss",
            selected: true,
            accessRole: "freeBusyReader",
          },
        ],
      });
    if (path === "/calendars/me%40acme.com/events")
      return json({ items: primaryEvents });
    if (path === "/calendars/family123%40group.calendar.google.com/events")
      return json({ items: familyEvents });
    if (path === "/calendars/me%40acme.com/events/dana-sync")
      return json(primaryEvents[1]);
    if (path === "/freeBusy") {
      const body = JSON.parse(init?.body as string) as {
        items: { id: string }[];
      };
      return json({
        calendars: Object.fromEntries(
          body.items.map(({ id }) => [
            id,
            id === "stranger@other.com"
              ? { errors: [{ reason: "notFound" }] }
              : {
                  busy: [
                    {
                      start: "2026-09-29T14:00:00Z",
                      end: "2026-09-29T15:00:00Z",
                    },
                  ],
                },
          ]),
        ),
      });
    }
    return new Response("{}", { status: 404 });
  };
  const fetchImpl = ((input: string, init?: RequestInit) =>
    Promise.resolve(respond(input, init))) as unknown as typeof fetch;
  return {
    requests,
    calendar: googleCalendarReader({
      address: "me@acme.com",
      accessToken: () => Promise.resolve("t"),
      fetch: fetchImpl,
    }),
  };
}

const range = {
  since: new Date("2026-09-29T04:00:00Z"),
  until: new Date("2026-10-06T04:00:00Z"),
};

describe("Google Calendar events", () => {
  test("normalize: responses, rooms dropped, video link, the user's own answer and the series", () => {
    const event = toCalendarEvent("me@acme.com", danaSync, "me@acme.com");
    expect(event).toMatchObject({
      providerId: "me@acme.com/dana-sync",
      title: "Sync with Dana",
      allDay: false,
      location: "Café",
      organizer: { email: "dana@example.com", name: "Dana Reyes", self: false },
      myResponse: "needs_action",
      videoLink: "https://meet.google.com/abc",
      seriesId: null,
    });
    expect(event.attendees.map((a) => `${a.email}:${a.response}`)).toEqual([
      "dana@example.com:accepted",
      "me@acme.com:needs_action",
    ]);
    const occurrence = toCalendarEvent(
      "me@acme.com",
      standup("2026-09-29"),
      "me@acme.com",
    );
    expect(occurrence.seriesId).toBe("me@acme.com/standup");
  });

  test("external means someone outside the account's domain; for consumer addresses, anyone else", () => {
    const at = (emails: string[]): CalendarEvent =>
      ({
        attendees: emails.map((email) => ({
          email,
          name: null,
          response: "accepted",
          optional: false,
          self: false,
        })),
      }) as unknown as CalendarEvent;
    expect(isExternal(at(["sam@acme.com"]), "me@acme.com")).toBe(false);
    expect(
      isExternal(at(["sam@acme.com", "dana@example.com"]), "me@acme.com"),
    ).toBe(true);
    expect(isExternal(at(["friend@gmail.com"]), "me@gmail.com")).toBe(true);
    expect(isExternal(at([]), "me@gmail.com")).toBe(false);
  });

  test("an all-day event starts at midnight in the user's zone", () => {
    const trip = toCalendarEvent("family", tripEvent, "me@acme.com");
    expect(trip.allDay).toBe(true);
    expect(trip.start).toEqual({ date: "2026-09-30" });
    expect(startInstant(trip, "America/New_York").toISOString()).toBe(
      "2026-09-30T04:00:00.000Z",
    );
  });

  test("ids split at the first slash; anything else isn't an event", () => {
    expect(splitEventId("me@acme.com/standup_20260929T140000Z")).toEqual({
      calendarId: "me@acme.com",
      eventId: "standup_20260929T140000Z",
    });
    expect(() => splitEventId("nonsense")).toThrow(ProviderNotFoundError);
  });
});

describe("googleCalendarReader", () => {
  test("lists the selected calendars merged by start, occurrences expanded, cancellations left out", async () => {
    const { calendar, requests } = fakeCalendar();
    const page = await calendar.list(range, { limit: 10 });
    expect(page.items.map((e) => e.title)).toEqual([
      "Standup",
      "Sync with Dana",
      "Trip",
      "Standup",
    ]);
    expect(page.cursor).toBeNull();
    // Only readable, selected calendars; with occurrences expanded.
    const listed = requests.filter((r) => r.includes("/events?"));
    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain("singleEvents=true");
    expect(listed[0]).toContain("orderBy=startTime");
  });

  test("filters by attendee, organizer, title and external; --calendar picks one by name", async () => {
    const { calendar } = fakeCalendar();
    expect(
      (
        await calendar.list({ ...range, attendee: "dana" }, { limit: 10 })
      ).items.map((e) => e.title),
    ).toEqual(["Sync with Dana"]);
    expect(
      (
        await calendar.list({ ...range, external: true }, { limit: 10 })
      ).items.map((e) => e.title),
    ).toEqual(["Sync with Dana"]);
    expect(
      (
        await calendar.list({ ...range, calendarId: "family" }, { limit: 10 })
      ).items.map((e) => e.title),
    ).toEqual(["Trip"]);
    expect(
      calendar.list({ ...range, calendarId: "nope" }, { limit: 10 }),
    ).rejects.toThrow(/The calendars are/);
  });

  test("pages with a cursor that resumes at the next event", async () => {
    const { calendar } = fakeCalendar();
    const first = await calendar.list(range, { limit: 2 });
    expect(first.items.map((e) => e.title)).toEqual([
      "Standup",
      "Sync with Dana",
    ]);
    expect(first.cursor).not.toBeNull();
  });

  test("get returns one event; freeBusy gives the user's calendars together and attendees where visible", async () => {
    const { calendar } = fakeCalendar();
    expect((await calendar.get("me@acme.com/dana-sync")).title).toBe(
      "Sync with Dana",
    );
    const busy = await calendar.freeBusy({
      since: range.since,
      until: range.until,
      attendees: ["dana@example.com", "stranger@other.com"],
    });
    expect(busy.get("me@acme.com")).toHaveLength(2);
    expect(busy.get("dana@example.com")).toHaveLength(1);
    expect(busy.get("stranger@other.com")).toBe("unknown");
  });
});
