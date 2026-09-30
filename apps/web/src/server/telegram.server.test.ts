import { describe, expect, test } from "bun:test";
import { telegramLinks } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { consumeLinkToken } from "@winston/db/telegram-link-tokens";
import { createDeepLink, telegramLinkOf } from "./telegram.server";

const db = await testDb();

describe("Telegram linking on the site", () => {
  test("the deep link opens the bot with a token that links this user, for 15 minutes", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const before = Date.now();
      const { url, expiresAt } = await createDeepLink(
        tx,
        user.id,
        "RunWinstonDevBot",
      );
      const match = /^https:\/\/t\.me\/RunWinstonDevBot\?start=([\w-]+)$/.exec(
        url,
      );
      expect(match).not.toBeNull();
      expect(Date.parse(expiresAt) - before).toBeGreaterThanOrEqual(
        15 * 60_000,
      );
      expect(await consumeLinkToken(tx, match?.[1] ?? "")).toBe(user.id);
    });
  });

  test("reports the linked chat's username, or null when there's none", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      expect(await telegramLinkOf(tx, user.id)).toBeNull();
      await tx.insert(telegramLinks).values({
        userId: user.id,
        chatId: 77,
        telegramUserId: 77,
        username: "ada_l",
      });
      expect(await telegramLinkOf(tx, user.id)).toMatchObject({
        username: "ada_l",
      });
    });
  });
});
