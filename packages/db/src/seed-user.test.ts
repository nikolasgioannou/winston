import { describe, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { allowedEmails, telegramLinks, users } from "./schema/index.ts";
import { seedUser } from "./seed-user.ts";
import { inRollback, testDb } from "./testing.ts";

const db = await testDb();
const input = {
  email: "seed@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  timezone: "Europe/London",
};

describe("seedUser", () => {
  test("running twice leaves one user and one allowlist entry", async () => {
    await inRollback(db, async (tx) => {
      const first = await seedUser(tx, input);
      const second = await seedUser(tx, { ...input, firstName: "Augusta" });
      expect(second).toBe(first);

      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.email, input.email));
      expect(user?.firstName).toBe("Augusta");
      expect(await tx.select({ n: count() }).from(users)).toEqual([{ n: 1 }]);
      expect(await tx.select({ n: count() }).from(allowedEmails)).toEqual([
        { n: 1 },
      ]);
    });
  });

  test("links a Telegram chat, and relinking updates it instead of duplicating", async () => {
    await inRollback(db, async (tx) => {
      const userId = await seedUser(tx, { ...input, telegramChatId: 111 });
      await seedUser(tx, { ...input, telegramChatId: 222 });

      const links = await tx.select().from(telegramLinks);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        userId,
        chatId: 222,
        telegramUserId: 222,
      });
    });
  });

  test("doesn't link a chat when none is given", async () => {
    await inRollback(db, async (tx) => {
      await seedUser(tx, input);
      expect(await tx.select().from(telegramLinks)).toEqual([]);
    });
  });
});
