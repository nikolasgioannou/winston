import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { inRollback, insertUser, testDb } from "../testing.ts";
import { telegramLinks, users } from "./index.ts";

const db = await testDb();

describe("identity constraints", () => {
  test("user emails are unique", async () => {
    await inRollback(db, async (tx) => {
      await insertUser(tx, { email: "same@example.com" });
      const error = await insertUser(tx, { email: "same@example.com" }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
    });
  });

  test("a Telegram chat links to at most one user", async () => {
    await inRollback(db, async (tx) => {
      const [a, b] = [await insertUser(tx), await insertUser(tx)];
      await tx
        .insert(telegramLinks)
        .values({ userId: a.id, chatId: 42, telegramUserId: 42 });
      const duplicate = async () => {
        await tx
          .insert(telegramLinks)
          .values({ userId: b.id, chatId: 42, telegramUserId: 42 });
      };
      const error = await duplicate().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
    });
  });

  test("deleting a user removes their Telegram link", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await tx
        .insert(telegramLinks)
        .values({ userId: user.id, chatId: 7, telegramUserId: 7 });
      await tx.delete(users).where(eq(users.id, user.id));
      expect(await tx.select().from(telegramLinks)).toEqual([]);
    });
  });
});
