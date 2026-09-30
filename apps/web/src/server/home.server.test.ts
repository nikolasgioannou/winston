import { describe, expect, test } from "bun:test";
import { telegramLinks } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { requestVm } from "@winston/db/vms";
import { homeState } from "./home.server";

const db = await testDb();

describe("homeState", () => {
  test("a fresh user's computer is setting up and nothing is linked", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx, { firstName: "Ada" });
      await requestVm(tx, user.id);
      expect(await homeState(tx, user)).toEqual({
        firstName: "Ada",
        computer: "setting_up",
        telegramLinked: false,
        accountsConnected: 0,
        attention: [],
      });
    });
  });

  test("a linked Telegram chat counts", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await tx
        .insert(telegramLinks)
        .values({ userId: user.id, chatId: 42, telegramUserId: 42 });
      expect((await homeState(tx, user)).telegramLinked).toBe(true);
    });
  });
});
