import { describe, expect, test } from "bun:test";
import { hashToken } from "@winston/shared/tokens";
import { telegramLinks, telegramLinkTokens } from "./schema/index.ts";
import {
  consumeLinkToken,
  isLinkTokenFormat,
  issueLinkToken,
  linkTokenLifetimeMs,
  unlinkTelegram,
} from "./telegram-link-tokens.ts";
import { inRollback, insertUser, testDb } from "./testing.ts";

const db = await testDb();
const now = new Date("2026-09-28T12:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);

describe("isLinkTokenFormat", () => {
  test("accepts what Telegram carries in a deep link, and nothing else", () => {
    expect(isLinkTokenFormat("abc_DEF-123")).toBe(true);
    expect(isLinkTokenFormat("a".repeat(64))).toBe(true);
    expect(isLinkTokenFormat("a".repeat(65))).toBe(false);
    expect(isLinkTokenFormat("")).toBe(false);
    expect(isLinkTokenFormat("has space")).toBe(false);
    expect(isLinkTokenFormat("slash/or+plus=")).toBe(false);
  });
});

describe("Telegram link tokens", () => {
  test("issued tokens fit a deep link and are stored only as a hash", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      for (let i = 0; i < 20; i += 1) {
        const token = await issueLinkToken(tx, user.id, now);
        expect(isLinkTokenFormat(token)).toBe(true);
        expect(token).toHaveLength(43);
      }
      const rows = await tx.select().from(telegramLinkTokens);
      expect(rows).toHaveLength(20);
      expect(rows[0]?.expiresAt).toEqual(later(linkTokenLifetimeMs));
      expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.tokenHash))).toBe(
        true,
      );
    });
  });

  test("a token works once", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const token = await issueLinkToken(tx, user.id, now);
      expect(await consumeLinkToken(tx, token, now)).toBe(user.id);
      expect(await consumeLinkToken(tx, token, now)).toBeUndefined();
    });
  });

  test("a token stops working when it expires", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const fresh = await issueLinkToken(tx, user.id, now);
      const stale = await issueLinkToken(tx, user.id, now);
      expect(
        await consumeLinkToken(tx, fresh, later(linkTokenLifetimeMs - 1)),
      ).toBe(user.id);
      expect(
        await consumeLinkToken(tx, stale, later(linkTokenLifetimeMs)),
      ).toBeUndefined();
    });
  });

  test("unknown and malformed tokens link nobody", async () => {
    await inRollback(db, async (tx) => {
      expect(await consumeLinkToken(tx, "nope", now)).toBeUndefined();
      expect(await consumeLinkToken(tx, "not a token!", now)).toBeUndefined();
      expect(await consumeLinkToken(tx, hashToken("x"), now)).toBeUndefined();
    });
  });

  test("issuing a token clears expired ones", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await issueLinkToken(tx, user.id, now);
      await issueLinkToken(tx, user.id, later(linkTokenLifetimeMs + 1));
      expect(await tx.select().from(telegramLinkTokens)).toHaveLength(1);
    });
  });
});

describe("unlinkTelegram", () => {
  test("removes the user's chat, once", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await tx
        .insert(telegramLinks)
        .values({ userId: user.id, chatId: 4242, telegramUserId: 4242 });
      expect(await unlinkTelegram(tx, user.id)).toBe(true);
      expect(await unlinkTelegram(tx, user.id)).toBe(false);
    });
  });
});
