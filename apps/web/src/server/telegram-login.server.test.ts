import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { returnPath } from "./return-path";
import { checkTelegramLogin, telegramLoginKey } from "./telegram-login.server";

const botToken = "123456:test-bot-token";
const loginKey = telegramLoginKey(botToken);
const now = new Date("2026-10-03T12:00:00Z");

/** A login as Telegram signs it: the fields, then their hash. */
function signed(fields: Record<string, string>, next?: string) {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  const key = createHash("sha256").update(botToken).digest();
  const hash = createHmac("sha256", key).update(check).digest("hex");
  return new URLSearchParams({
    ...(next ? { next } : {}),
    ...fields,
    hash,
  });
}

const fields = {
  id: "424242",
  first_name: "Nik",
  username: "nik",
  auth_date: String(Math.floor(now.getTime() / 1000) - 30),
};

describe("Telegram sign-in", () => {
  test("a recent, correctly signed login is accepted, our own next aside", () => {
    expect(
      checkTelegramLogin(
        signed(fields, "/browser?window=win_1"),
        loginKey,
        now,
      ),
    ).toMatchObject({
      ok: true,
      telegramUserId: 424242,
    });
  });

  test("a tampered field, the wrong bot, a stale login or a missing hash are refused", () => {
    const tampered = signed(fields);
    tampered.set("id", "1");
    expect(checkTelegramLogin(tampered, loginKey, now)).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(
      checkTelegramLogin(signed(fields), telegramLoginKey("999:other"), now),
    ).toEqual({
      ok: false,
      reason: "signature",
    });
    const stale = signed({
      ...fields,
      auth_date: String(Math.floor(now.getTime() / 1000) - 3 * 60),
    });
    expect(checkTelegramLogin(stale, loginKey, now)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(
      checkTelegramLogin(new URLSearchParams({ id: "1" }), loginKey, now),
    ).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  test("after signing in, only the connect flow and the browser page can be returned to", () => {
    expect(returnPath("/browser?window=win_1")).toBe("/browser?window=win_1");
    expect(returnPath("/auth/google/connect?domain=mail")).toBe(
      "/auth/google/connect?domain=mail",
    );
    expect(returnPath("/sites/open?site=blog")).toBe("/sites/open?site=blog");
    expect(returnPath("https://evil.test/browser")).toBeUndefined();
    expect(returnPath("//evil.test/browser")).toBeUndefined();
    expect(returnPath("/home")).toBeUndefined();
  });
});
