import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { updateProfile } from "./profile.ts";
import { inboundItems, users } from "./schema/index.ts";
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
