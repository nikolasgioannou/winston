import { describe, expect, test } from "bun:test";
import { cli } from "../testing.ts";
import { minutes } from "../flags.ts";
import { span } from "./calendar.ts";

const person = (email: string, overrides: Record<string, unknown> = {}) => ({
  email,
  name: null,
  response: "accepted",
  optional: false,
  self: false,
  ...overrides,
});

const event = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  seriesId: null,
  calendar: "me@example.com",
  calendarName: "me@example.com",
  title: "Sync with Dana",
  start: { at: "2026-09-29T19:00:00.000Z" },
  end: { at: "2026-09-29T19:30:00.000Z" },
  allDay: false,
  location: null,
  description: null,
  organizer: { email: "me@example.com", name: null, self: true },
  attendees: [
    person("me@example.com", { self: true }),
    person("dana@other.com", { name: "Dana Reyes" }),
    person("sam@example.com", { response: "needs_action", optional: true }),
  ],
  myResponse: "accepted",
  status: "confirmed",
  videoLink: "https://meet.google.com/abc-defg-hij",
  recurrence: null,
  external: true,
  ...overrides,
});

const page = {
  account: { id: "acct_1", email: "me@example.com" },
  timeZone: "America/New_York",
  range: {
    since: "2026-09-29T04:00:00.000Z",
    until: "2026-10-06T04:00:00.000Z",
  },
  events: [
    event("evt_01sync"),
    event("evt_01trip", {
      title: "Lake trip",
      calendar: "fam123@group.calendar.google.com",
      calendarName: "Family",
      start: { date: "2026-09-30" },
      end: { date: "2026-10-03" },
      allDay: true,
      attendees: [],
      videoLink: null,
      external: false,
    }),
    event("evt_01board", {
      title: "Board prep",
      seriesId: "evt_01series",
      organizer: { email: "boss@acme.com", name: "Pat", self: false },
      myResponse: "needs_action",
      attendees: [person("boss@acme.com"), person("me@example.com")],
      videoLink: null,
      external: false,
      start: { at: "2026-10-02T03:30:00.000Z" },
      end: { at: "2026-10-02T05:00:00.000Z" },
    }),
  ],
  cursor: "c_9",
};

const free = {
  account: { id: "acct_1", email: "me@example.com" },
  timeZone: "America/New_York",
  range: {
    since: "2026-10-05T04:00:00.000Z",
    until: "2026-10-10T04:00:00.000Z",
  },
  duration: 30,
  hours: { start: 540, end: 1080, weekends: false },
  considered: [
    { who: "me@example.com", visible: true },
    { who: "dana@other.com", visible: true },
    { who: "pat@elsewhere.com", visible: false },
  ],
  slots: [
    { start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T14:00:00.000Z" },
    { start: "2026-10-05T19:30:00.000Z", end: "2026-10-05T22:00:00.000Z" },
    { start: "2026-10-06T13:00:00.000Z", end: "2026-10-06T22:00:00.000Z" },
  ],
};

const bodyOf = async (request: Request | undefined) =>
  (await request?.clone().json()) as Record<string, unknown>;

describe("winston calendar", () => {
  test("list prints one line per event in the user's zone, naming other calendars, with a footer", async () => {
    const { code, out, requests } = await cli(
      [
        "calendar",
        "list",
        "--since",
        "2026-10-01",
        "--until",
        "2026-10-02",
        "--external",
      ],
      () => Response.json(page),
    );
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "evt_01sync  Tue 09-29 15:00–15:30 -04:00  Sync with Dana  [3 attendees, external, video]",
        "evt_01trip  Wed 09-30 → Fri 10-02 all day  Lake trip  Family",
        "evt_01board  Thu 10-01 23:30 → Fri 10-02 01:00 -04:00  Board prep  [2 attendees, repeats, not answered]",
        "… more. To see them, use --cursor c_9 or narrow with --until, --attendee or --title.",
      ].join("\n"),
    );
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/calendar/events");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      since: "2026-10-01",
      until: "2026-10-02",
      external: "true",
    });
  });

  test("search needs words and sends them as text", async () => {
    const { requests } = await cli(
      ["calendar", "search", "board", "prep", "--attendee", "pat"],
      () => Response.json({ ...page, cursor: null }),
    );
    expect(
      Object.fromEntries(new URL(requests[0]?.url ?? "").searchParams),
    ).toEqual({ text: "board prep", attendee: "pat" });
    expect(
      (await cli(["calendar", "search"], () => Response.json(page))).code,
    ).toBe(1);
  });

  test("get shows when, where, the video link and each attendee's answer", async () => {
    const { out, requests } = await cli(["calendar", "get", "evt_01sync"], () =>
      Response.json({
        account: page.account,
        timeZone: "America/New_York",
        event: event("evt_01sync", {
          location: "Room 4",
          description: "Agenda: the lease.",
        }),
      }),
    );
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/calendar/events/evt_01sync",
    );
    expect(out).toBe(
      [
        "evt_01sync · Sync with Dana",
        "When: Tue 2026-09-29 15:00–15:30 -04:00 (America/New_York)",
        "Where: Room 4",
        "Video: https://meet.google.com/abc-defg-hij",
        "Organizer: me@example.com (you)",
        "Has people from outside the account's organization.",
        "Attendees (3):",
        "  me@example.com  accepted, organizer, you",
        "  Dana Reyes <dana@other.com>  accepted",
        "  sam@example.com  hasn't answered, optional",
        "",
        "Agenda: the lease.",
      ].join("\n"),
    );
  });

  test("free groups slots by day in the user's zone and says whose time it couldn't see", async () => {
    const { out, requests } = await cli(
      [
        "calendar",
        "free",
        "--attendee",
        "dana@other.com",
        "--attendee",
        "pat@elsewhere.com",
        "--duration",
        "1h30m",
        "--since",
        "2026-10-05",
      ],
      () => Response.json(free),
    );
    const url = new URL(requests[0]?.url ?? "");
    expect(url.searchParams.getAll("attendee")).toEqual([
      "dana@other.com",
      "pat@elsewhere.com",
    ]);
    expect(url.searchParams.get("duration")).toBe("90");
    expect(out).toBe(
      [
        "Free for 30 min, weekdays 9:00–18:00, America/New_York:",
        "Mon 10-05  09:00–10:00, 15:30–18:00",
        "Tue 10-06  09:00–18:00",
        "Checked: me@example.com, dana@other.com",
        "Couldn't see when pat@elsewhere.com is busy (not shared), so check with them.",
      ].join("\n"),
    );
  });

  test("create needs exactly one of --end, --duration or --all-day, and sends times as typed", async () => {
    const backend = () =>
      Response.json({
        account: page.account,
        timeZone: "America/New_York",
        dryRun: true,
        notifies: ["sam@acme.com"],
        event: {
          title: "1:1 with Sam",
          start: { at: "2026-10-06T14:00:00.000Z" },
          end: { at: "2026-10-06T14:30:00.000Z" },
          allDay: false,
          calendar: "primary",
          attendees: ["sam@acme.com"],
          location: null,
          video: true,
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
        },
      });
    for (const how of [[], ["--duration", "30m", "--all-day"]]) {
      const refused = await cli(
        ["calendar", "create", "--title", "x", "--start", "tue 10am", ...how],
        backend,
      );
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(
        "exactly one of --end, --duration or --all-day",
      );
      expect(refused.requests).toHaveLength(0);
    }
    const { out, requests } = await cli(
      [
        "calendar",
        "create",
        "--title",
        "1:1 with Sam",
        "--start",
        "tue 10am",
        "--duration",
        "30m",
        "--attendee",
        "sam@acme.com",
        "--video",
        "--repeat",
        "FREQ=WEEKLY;BYDAY=TU",
        "--dry-run",
      ],
      backend,
    );
    expect(await bodyOf(requests[0])).toEqual({
      title: "1:1 with Sam",
      start: "tue 10am",
      duration: 30,
      allDay: false,
      attendees: ["sam@acme.com"],
      video: true,
      repeat: "FREQ=WEEKLY;BYDAY=TU",
      dryRun: true,
    });
    expect(out).toBe(
      [
        "DRY RUN (nothing created)",
        'Would create "1:1 with Sam"  Tue 10-06 10:00–10:30 -04:00  in me@example.com',
        "attendees: sam@acme.com",
        "with a Google Meet link",
        "repeats: RRULE:FREQ=WEEKLY;BYDAY=TU",
        "Would email: sam@acme.com",
      ].join("\n"),
    );
  });

  test("update sends only what changes, with the scope and notify choice, and shows who's emailed", async () => {
    const { out, requests } = await cli(
      [
        "calendar",
        "update",
        "evt_01sync",
        "--start",
        "2026-10-01T15:00",
        "--scope",
        "following",
        "--notify",
      ],
      () =>
        Response.json({
          account: page.account,
          timeZone: "America/New_York",
          dryRun: false,
          scope: "following",
          notifies: ["dana@other.com", "sam@example.com"],
          keptMinutes: 30,
          event: {
            id: "evt_01new",
            title: "Sync with Dana",
            start: { at: "2026-10-01T19:00:00.000Z" },
            end: { at: "2026-10-01T19:30:00.000Z" },
            allDay: false,
            location: null,
            attendees: [{ email: "dana@other.com", response: "accepted" }],
            videoLink: null,
            recurrence: null,
          },
        }),
    );
    expect(requests[0]?.method).toBe("PATCH");
    expect(await bodyOf(requests[0])).toEqual({
      start: "2026-10-01T15:00",
      addAttendees: [],
      removeAttendees: [],
      scope: "following",
      notify: true,
      dryRun: false,
    });
    expect(out).toBe(
      [
        'Changed evt_01new (this and following): "Sync with Dana"  Thu 10-01 15:00–15:30 -04:00',
        "It kept its 30m length; pass --end or --duration to change that.",
        "attendees: dana@other.com",
        "Emailed: dana@other.com, sam@example.com",
      ].join("\n"),
    );
    const nothing = await cli(["calendar", "update", "evt_01sync"], () =>
      Response.json({}),
    );
    expect(nothing.code).toBe(1);
    const typo = await cli(
      ["calendar", "update", "evt_01sync", "--title", "x", "--scope", "every"],
      () => Response.json({}),
    );
    expect(typo.code).toBe(1);
    expect(typo.requests).toHaveLength(0);
  });

  test("delete and rsvp say what happened and who hears about it", async () => {
    const deleted = await cli(
      ["calendar", "delete", "evt_01sync", "--dry-run", "--no-notify"],
      () =>
        Response.json({
          dryRun: true,
          deleted: "evt_01sync",
          title: "Sync with Dana",
          scope: "this",
          notifies: [],
        }),
    );
    expect(await bodyOf(deleted.requests[0])).toEqual({
      scope: "this",
      notify: false,
      dryRun: true,
    });
    expect(deleted.out).toBe(
      [
        "DRY RUN (nothing deleted)",
        'Would delete evt_01sync "Sync with Dana".',
        "Would email no one.",
      ].join("\n"),
    );
    const declined = await cli(
      [
        "calendar",
        "rsvp",
        "evt_01board",
        "--decline",
        "--note",
        "Out that day",
      ],
      () =>
        Response.json({
          dryRun: false,
          id: "evt_01board",
          title: "Board prep",
          response: "declined",
          note: "Out that day",
          scope: "this",
          organizer: "boss@acme.com",
        }),
    );
    expect(await bodyOf(declined.requests[0])).toEqual({
      response: "declined",
      note: "Out that day",
      scope: "this",
      dryRun: false,
    });
    expect(declined.out).toBe(
      'Declined evt_01board "Board prep" with the note "Out that day".\nTold boss@acme.com.',
    );
    const both = await cli(
      ["calendar", "rsvp", "evt_01board", "--accept", "--decline"],
      () => Response.json({}),
    );
    expect(both.code).toBe(1);
  });

  test("API errors keep their exit codes and hints", async () => {
    const result = await cli(
      ["calendar", "create", "--title", "x", "--start", "tue", "--all-day"],
      () =>
        Response.json(
          {
            error: {
              code: "permission_disabled",
              message: "Creating events is turned off for me@example.com.",
              hint: "The user can turn it on at https://runwinston.com/accounts",
            },
          },
          { status: 403 },
        ),
    );
    expect(result.code).toBe(3);
    expect(result.err).toContain("Creating events is turned off");
    const notSupported = await cli(
      ["calendar", "rsvp", "evt_01x", "--accept"],
      () =>
        Response.json(
          {
            error: {
              code: "not_supported",
              message: "This account isn't invited to that event.",
              hint: null,
            },
          },
          { status: 400 },
        ),
    );
    expect(notSupported.code).toBe(7);
  });
});

describe("calendar formatting", () => {
  test("spans: same day, overnight, all day, several days, with the year for get", () => {
    const tz = "Europe/London";
    expect(
      span({ at: "2026-10-25T00:30:00Z" }, { at: "2026-10-25T02:00:00Z" }, tz),
    ).toBe("Sun 10-25 01:30–02:00 +00:00");
    expect(span({ date: "2026-12-25" }, { date: "2026-12-26" }, tz, true)).toBe(
      "Fri 2026-12-25 all day",
    );
  });

  test("durations: minutes, hours, both, or a bare number of minutes", () => {
    expect(minutes("30m")).toBe(30);
    expect(minutes("45min")).toBe(45);
    expect(minutes("1h")).toBe(60);
    expect(minutes("1h30m")).toBe(90);
    expect(minutes("90")).toBe(90);
    expect(() => minutes("half an hour")).toThrow("isn't a duration");
    expect(() => minutes("0m")).toThrow("isn't a duration");
  });
});
