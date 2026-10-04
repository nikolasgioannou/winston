import { describe, expect, test } from "bun:test";
import { resources } from "../cli.ts";
import { cli } from "../testing.ts";

const capability = (
  name: string,
  description: string,
  on = true,
  granted = true,
) => ({
  name,
  description,
  on,
  granted,
});

const calendarAccount = {
  id: "acct_01cal",
  domain: "calendar",
  provider: "google_calendar",
  email: "me@example.com",
  status: "ok",
  capabilities: [
    capability("read", "reading"),
    capability("create", "creating events", false),
    capability("update", "changing events"),
    capability("delete", "deleting events", false),
    capability("rsvp", "answering invitations", true, false),
  ],
  calendars: [
    {
      id: "me@example.com",
      name: "me@example.com",
      primary: true,
      writable: true,
      timeZone: "America/New_York",
    },
    {
      id: "fam1@group.calendar.google.com",
      name: "Family",
      primary: false,
      writable: true,
      timeZone: null,
    },
    {
      id: "en.usa#holiday@group.v.calendar.google.com",
      name: "Holidays",
      primary: false,
      writable: false,
      timeZone: null,
    },
  ],
  calendarsNote: null,
  notes: ["--video adds a Google Meet link."],
  links: {
    settings: "https://runwinston.com/accounts?account=acct_01cal",
    reconnect:
      "https://runwinston.com/auth/google/connect?reconnect=acct_01cal",
  },
};

/** A real-looking TypeID for `prefix`. */
const id = (prefix: string) => `${prefix}_01k5x9q8f3e2d1c0b9a8z7y6x5`;

describe("winston accounts", () => {
  test("list lines up id, type, provider, address and status", async () => {
    const { out, requests } = await cli(["accounts", "list"], () =>
      Response.json({
        accounts: [
          {
            id: "acct_01mail",
            domain: "mail",
            provider: "gmail",
            email: "me@example.com",
            status: "ok",
          },
          {
            id: "acct_01cal",
            domain: "calendar",
            provider: "google_calendar",
            email: "me@example.com",
            status: "expiring",
          },
        ],
      }),
    );
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/accounts");
    expect(out).toBe(
      [
        "acct_01mail  mail      Gmail            me@example.com  ok",
        "acct_01cal   calendar  Google Calendar  me@example.com  auth expiring",
      ].join("\n"),
    );
    const none = await cli(["accounts", "list"], () =>
      Response.json({ accounts: [] }),
    );
    expect(none.out).toBe(
      "No accounts are connected. winston accounts connect mail (or calendar) gives a link to send the user.",
    );
  });

  test("connect prints the link for one domain and says the other is separate; anything else is a usage error", async () => {
    const { out, requests } = await cli(
      ["accounts", "connect", "calendar"],
      () =>
        Response.json({
          domain: "calendar",
          url: "https://runwinston.com/auth/google/connect?domain=calendar",
          connected: [],
        }),
    );
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/accounts/connect/calendar",
    );
    expect(out).toContain(
      "  https://runwinston.com/auth/google/connect?domain=calendar",
    );
    expect(out).toContain("mail is a separate connection");
    expect(out).toContain("No calendar account is connected yet.");
    const bad = await cli(["accounts", "connect", "drive"], () =>
      Response.json({}),
    );
    expect(bad.requests).toHaveLength(0);
    expect(bad.code).toBe(1);
  });

  test("connect mail also says where the user gives Winston his own address, or what it is", async () => {
    const mail = (winstonMailbox: unknown) =>
      cli(["accounts", "connect", "mail"], () =>
        Response.json({
          domain: "mail",
          url: "https://runwinston.com/auth/google/connect?domain=mail",
          connected: [],
          winstonMailbox,
        }),
      );
    expect(
      (
        await mail({
          status: "never",
          address: null,
          url: "https://runwinston.com/channels?email=setup",
        })
      ).out,
    ).toContain(
      "You have no email address of your own yet. The user can give you one at https://runwinston.com/channels?email=setup",
    );
    expect(
      (
        await mail({
          status: "on",
          address: "ada@runwinston.email",
          url: "https://runwinston.com/channels",
        })
      ).out,
    ).toContain("Your own address is ada@runwinston.email");
    expect(
      (
        await mail({
          status: "off",
          address: "ada@runwinston.email",
          url: "https://runwinston.com/channels",
        })
      ).out,
    ).toContain(
      "Your own address, ada@runwinston.email, is turned off. The user can turn it on at https://runwinston.com/channels",
    );
  });

  test("get shows each permission clearly as on, off or not granted, with where to fix it, then calendars and notes", async () => {
    const { out, requests } = await cli(
      ["accounts", "get", "me@example.com"],
      () => Response.json({ accounts: [calendarAccount] }),
    );
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/accounts/me@example.com",
    );
    expect(out).toBe(
      [
        "acct_01cal · me@example.com · Google Calendar (calendar) · ok",
        "Permissions:",
        "  read    on           reading",
        "  create  off          creating events",
        "  update  on           changing events",
        "  delete  off          deleting events",
        "  rsvp    not granted  answering invitations",
        "The user turns permissions on or off at https://runwinston.com/accounts?account=acct_01cal",
        '"Not granted" was left unticked on Google\'s screen; the user can reconnect to allow it: https://runwinston.com/auth/google/connect?reconnect=acct_01cal',
        "Calendars:",
        "  me@example.com: primary, can add events",
        "  Family (fam1@group.calendar.google.com): can add events",
        "  Holidays (en.usa#holiday@group.v.calendar.google.com): read only",
        "Notes:",
        "  - --video adds a Google Meet link.",
      ].join("\n"),
    );
  });
});

describe("winston get", () => {
  test("routes every registered prefix to its resource's get", async () => {
    const paths: Record<string, string> = {
      msg: "/v1/mail/messages/",
      thr: "/v1/mail/messages/",
      att: "/v1/mail/attachments/",
      evt: "/v1/calendar/events/",
      acct: "/v1/accounts/",
      task: "/v1/tasks/",
      trg: "/v1/triggers/",
      hist: "/v1/history/",
      win: "/v1/browser/windows/",
    };
    const registered = resources.flatMap((r) => r.ids ?? []);
    expect(registered.sort()).toEqual(Object.keys(paths).sort());
    for (const [prefix, path] of Object.entries(paths)) {
      const { requests } = await cli(["get", id(prefix), "--json"], () =>
        Response.json({}),
      );
      expect(new URL(requests[0]?.url ?? "").pathname).toBe(
        `${path}${id(prefix)}`,
      );
    }
  });

  test("an attachment shows its name, type and size, and how to save it", async () => {
    const { out } = await cli(["get", id("att")], () =>
      Response.json({
        id: id("att"),
        filename: "lease.pdf",
        mimeType: "application/pdf",
        size: 81_234,
      }),
    );
    expect(out).toBe(
      `${id("att")} · lease.pdf · application/pdf · 79 KB\nSave it with: winston mail download ${id("att")}`,
    );
  });

  test("unknown and malformed ids exit 1 with a hint, without calling the backend", async () => {
    const unknown = await cli(["get", id("zzz")], () => Response.json({}));
    expect(unknown.code).toBe(1);
    expect(unknown.err).toBe(
      "winston get doesn't know zzz_ ids.\nIt knows msg_, thr_, att_, evt_, acct_, task_, trg_, hist_, win_.",
    );
    expect(unknown.requests).toHaveLength(0);
    for (const bad of [
      "evt_123",
      "dana@example.com",
      "EVT_01K5X9Q8F3E2D1C0B9A8Z7Y6X5",
    ]) {
      const malformed = await cli(["get", bad], () => Response.json({}));
      expect(malformed.code).toBe(1);
      expect(malformed.err).toContain("isn't an id.");
    }
    expect((await cli(["get"], () => Response.json({}))).out).toContain(
      "It knows msg_",
    );
  });
});
