import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { followBrowserTimezone, updateProfile } from "./profile.ts";
import { recordSystemEvent } from "./system-events.ts";
import { events, inboundItems, jobs, triggers, users } from "./schema/index.ts";
import { inRollback, insertUser, testDb } from "./testing.ts";

const db = await testDb();

const changesOf = async (tx: DbOrTx, userId: string) =>
  (
    await tx
      .select({ payload: inboundItems.payload })
      .from(inboundItems)
      .where(eq(inboundItems.userId, userId))
  ).map((item) => item.payload);

describe("updateProfile", () => {
  test("records one settings change per field that actually changes", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, {
        firstName: "Ada",
        lastName: "Lovelace",
        timezone: "America/New_York",
      });
      expect(
        await updateProfile(
          tx,
          user.id,
          { firstName: " Ada ", lastName: "King", timezone: "europe/london" },
          "site",
        ),
      ).toEqual({ ok: true, changed: ["timezone", "lastName"] });
      const [row] = await tx.select().from(users).where(eq(users.id, user.id));
      expect(row).toMatchObject({
        firstName: "Ada",
        lastName: "King",
        timezone: "Europe/London",
      });
      const changes = (await changesOf(tx, user.id)) as Record<
        string,
        string
      >[];
      expect(
        changes.sort((a, b) => String(a.field).localeCompare(String(b.field))),
      ).toEqual([
        { field: "last_name", old: "Lovelace", new: "King", source: "site" },
        {
          field: "timezone",
          old: "America/New_York",
          new: "Europe/London",
          source: "site",
        },
      ]);

      // The same values again change nothing and tell Winston nothing.
      expect(
        await updateProfile(
          tx,
          user.id,
          { timezone: "Europe/London" },
          "browser",
        ),
      ).toEqual({ ok: true, changed: [] });
      expect(await changesOf(tx, user.id)).toHaveLength(2);
    });
  });

  test("refuses an unknown zone or a blank first name, changing nothing", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      expect(
        await updateProfile(tx, user.id, { timezone: "Mars/Olympus" }, "site"),
      ).toEqual({ ok: false, problem: "invalid_timezone" });
      expect(
        await updateProfile(
          tx,
          user.id,
          { firstName: "  ", timezone: "UTC" },
          "site",
        ),
      ).toEqual({ ok: false, problem: "invalid_name" });
      const [row] = await tx.select().from(users).where(eq(users.id, user.id));
      expect(row?.timezone).toBe("America/New_York");
      expect(await changesOf(tx, user.id)).toEqual([]);
    });
  });
});

describe("followBrowserTimezone", () => {
  test("adopts the browser's zone when the device moves, but not over a zone Winston set while it stays put", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, {
        timezone: "America/New_York",
        browserTimezone: "America/New_York",
      });
      const zoneOf = async () =>
        (
          await tx
            .select({
              timezone: users.timezone,
              browser: users.browserTimezone,
            })
            .from(users)
            .where(eq(users.id, user.id))
        )[0];

      // "I'm in Tokyo this week": Winston sets it; the laptop still says New York.
      await updateProfile(tx, user.id, { timezone: "Asia/Tokyo" }, "winston");
      expect(
        await followBrowserTimezone(tx, user.id, "America/New_York"),
      ).toEqual({ updated: false });
      expect(await zoneOf()).toEqual({
        timezone: "Asia/Tokyo",
        browser: "America/New_York",
      });

      // The laptop lands in Tokyo too: nothing to change, but it's remembered…
      expect(await followBrowserTimezone(tx, user.id, "Asia/Tokyo")).toEqual({
        updated: false,
      });
      // …so coming home moves the zone back.
      expect(
        await followBrowserTimezone(tx, user.id, "America/New_York"),
      ).toEqual({ updated: true });
      expect(await zoneOf()).toEqual({
        timezone: "America/New_York",
        browser: "America/New_York",
      });
      const sources = (await changesOf(tx, user.id)).map(
        (p) => (p as { source: string }).source,
      );
      expect(sources).toEqual(["winston", "browser"]);
    });
  });

  test("a first report adopts the browser's zone; an unknown zone is ignored", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "UTC" });
      expect(await followBrowserTimezone(tx, user.id, "Europe/London")).toEqual(
        { updated: true },
      );
      expect(await followBrowserTimezone(tx, user.id, "Mars/Olympus")).toEqual({
        updated: false,
      });
    });
  });
});

describe("time zone changes and schedules", () => {
  test("a recurring schedule keeps its local time in the new zone; a one-off stays put", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      const once = new Date("2031-03-03T14:00:00Z");
      const [weekday] = await tx
        .insert(triggers)
        .values({
          userId: user.id,
          kind: "schedule",
          cron: "0 9 * * 1-5",
          note: "Morning briefing",
          nextFireAt: new Date("2031-03-03T14:00:00Z"),
        })
        .returning();
      const [oneOff] = await tx
        .insert(triggers)
        .values({
          userId: user.id,
          kind: "schedule",
          at: once,
          nextFireAt: once,
          note: "x",
        })
        .returning();
      await updateProfile(
        tx,
        user.id,
        { timezone: "Europe/London" },
        "winston",
      );
      const rows = Object.fromEntries(
        (await tx.select().from(triggers)).map((t) => [t.id, t.nextFireAt]),
      );
      const next = rows[weekday?.id ?? ""];
      // 9:00 in London is 08:00 or 09:00 UTC, depending on summer time.
      expect([8, 9]).toContain(next?.getUTCHours() ?? -1);
      expect(next?.getUTCMinutes()).toBe(0);
      expect(rows[oneOff?.id ?? ""]).toEqual(once);
    });
  });

  test("subscribable system events become catalog events to match; always-delivered ones don't", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { timezone: "America/New_York" });
      await updateProfile(tx, user.id, { timezone: "Europe/London" }, "site");
      await recordSystemEvent(tx, {
        userId: user.id,
        type: "system.app.auth_expiring",
        payload: {
          connectionId: "acct_1",
          domain: "mail",
          provider: "gmail",
          externalEmail: "a@b.c",
          expiresAt: "2026-10-08T00:00:00.000Z",
          reconnectUrl: "https://x",
        },
        sourceRef: "test:expiring",
      });
      const stored = await tx
        .select()
        .from(events)
        .where(eq(events.userId, user.id));
      expect(stored.map((e) => e.type)).toEqual(["system.settings.changed"]);
      const matches = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.type, "match_events"));
      expect(matches.map((j) => j.payload)).toEqual([
        { eventIds: [stored[0]?.id] },
      ]);
      // Both reach the front of house.
      const items = await tx
        .select()
        .from(inboundItems)
        .where(eq(inboundItems.userId, user.id));
      expect(items.map((i) => i.type).sort()).toEqual([
        "system.app.auth_expiring",
        "system.settings.changed",
      ]);
    });
  });
});
