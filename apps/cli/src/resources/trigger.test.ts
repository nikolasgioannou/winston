import { describe, expect, test } from "bun:test";
import { cli } from "../testing.ts";

const base = {
  status: "active",
  at: null,
  cron: null,
  on: null,
  account: null,
  scope: null,
  filter: {},
  native: null,
  leadMinutes: null,
  maxFires: null,
  fireCount: 0,
  expiresAt: null,
  onExpire: null,
  nextFireAt: null,
  createdAt: "2026-10-01T14:00:00.000Z",
};

const schedule = {
  ...base,
  id: "trg_01brief",
  kind: "schedule",
  cron: "0 8 * * 1-5",
  fireCount: 3,
  nextFireAt: "2026-10-05T12:00:00.000Z",
  note: "Morning briefing: today's meetings and anything urgent in mail.",
};

const subscription = {
  ...base,
  id: "trg_01dana",
  kind: "subscription",
  on: "mail.message.received",
  account: "me@example.com",
  scope: "thr_01lease",
  filter: { from: "dana", unread: true },
  maxFires: 1,
  expiresAt: "2026-10-09T13:00:00.000Z",
  onExpire: "Dana never replied; offer to draft a nudge.",
  note: "Dana replied about the lease; summarize it for Nik.",
};

const page = {
  timeZone: "America/New_York",
  triggers: [schedule, subscription],
};

describe("winston trigger", () => {
  test("list: what wakes each, its fires and expiry, and its note", async () => {
    const { out } = await cli(["trigger", "list"], () => Response.json(page));
    expect(out).toBe(
      [
        'trg_01brief  next 2026-10-05 08:00 -04:00  cron "0 8 * * 1-5"  fired 3  Morning briefing: today\'s meetings and anything urgent in mail.',
        "trg_01dana  on mail.message.received  --from dana --unread  in thr_01lease  fired 0 of 1  expires 2026-10-09 09:00 -04:00  Dana replied about the lease; summarize it for Nik.",
      ].join("\n"),
    );
  });

  test("get shows a subscription in full", async () => {
    const { out } = await cli(["trigger", "get", "trg_01dana"], () =>
      Response.json({ timeZone: "America/New_York", trigger: subscription }),
    );
    expect(out).toBe(
      [
        "trg_01dana · subscription · active",
        "On: mail.message.received (me@example.com)",
        "Filter: --from dana --unread",
        "Scope: thr_01lease",
        "Fired: 0 of 1",
        "Expires: 2026-10-09 09:00 -04:00, then: Dana never replied; offer to draft a nudge.",
        "Note:",
        "  Dana replied about the lease; summarize it for Nik.",
      ].join("\n"),
    );
  });

  test("create sends the filter flags from the catalog, --lead in minutes, and needs --note", async () => {
    const { requests } = await cli(
      [
        "trigger",
        "create",
        "--on",
        "calendar.event.starting",
        "--lead",
        "1h30m",
        "--external",
        "--min-attendees",
        "3",
        "--note",
        "Brief Nik on who's coming.",
      ],
      () =>
        Response.json({
          timeZone: "UTC",
          trigger: { ...subscription, kind: "subscription" },
        }),
    );
    expect(await requests[0]?.clone().json()).toEqual({
      on: "calendar.event.starting",
      filter: { external: true, "min-attendees": 3 },
      note: "Brief Nik on who's coming.",
      lead: 90,
    });
    const noNote = await cli(
      ["trigger", "create", "--at", "2026-10-09T09:00"],
      () => Response.json({}),
    );
    expect(noNote.code).toBe(1);
    expect(noNote.requests).toHaveLength(0);
    const unknown = await cli(
      [
        "trigger",
        "create",
        "--on",
        "mail.message.received",
        "--frm",
        "dana",
        "--note",
        "x",
      ],
      () => Response.json({}),
    );
    expect(unknown.err).toContain("Did you mean `--from`?");
  });

  test("update sends only what changes; delete confirms", async () => {
    const updated = await cli(
      ["trigger", "update", "trg_01brief", "--cron", "30 6 * * *"],
      () =>
        Response.json({
          timeZone: "America/New_York",
          trigger: { ...schedule, cron: "30 6 * * *" },
        }),
    );
    expect(updated.requests[0]?.method).toBe("PATCH");
    expect(await updated.requests[0]?.clone().json()).toEqual({
      cron: "30 6 * * *",
    });
    const deleted = await cli(["trigger", "delete", "trg_01brief"], () =>
      Response.json({ id: "trg_01brief", deleted: true }),
    );
    expect(deleted.requests[0]?.method).toBe("DELETE");
    expect(deleted.out).toBe("Deleted trg_01brief.");
  });
});
