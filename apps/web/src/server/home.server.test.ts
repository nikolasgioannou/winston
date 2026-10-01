import { describe, expect, test } from "bun:test";
import { connections, telegramLinks } from "@winston/db/schema";
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

  test("expired and expiring accounts need attention, expired first, each with its reconnect link", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const account = (
        id: string,
        overrides: Partial<typeof connections.$inferInsert>,
      ) => ({
        id,
        userId: user.id,
        domain: "mail" as const,
        provider: "gmail" as const,
        externalEmail: `${id}@acme.com`,
        tokenCiphertext: "local:v1:x",
        grantedAt: new Date(),
        ...overrides,
      });
      await tx.insert(connections).values([
        account("acct_ok", {}),
        account("acct_soon", { status: "expiring" }),
        account("acct_gone", {
          domain: "calendar",
          provider: "google_calendar",
          status: "expired",
        }),
        account("acct_off", { status: "disconnected" }),
      ]);
      const state = await homeState(tx, user);
      expect(state.accountsConnected).toBe(3);
      expect(state.attention).toEqual([
        {
          id: "acct_gone",
          tone: "error",
          title: "Calendar access for acct_gone@acme.com expired",
          description: "Reconnect so Winston can help with it again.",
          action: {
            label: "Reconnect",
            href: "/auth/google/connect?reconnect=acct_gone",
          },
        },
        {
          id: "acct_soon",
          tone: "attention",
          title: "Mail access for acct_soon@acme.com expires soon",
          description: "Reconnect so Winston can keep helping with it.",
          action: {
            label: "Reconnect",
            href: "/auth/google/connect?reconnect=acct_soon",
          },
        },
      ]);
    });
  });
});
