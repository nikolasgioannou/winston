/**
 * Telegram sign-in (docs/design.md §13): a `login_url` button in Winston's
 * messages opens the site with the tapper's Telegram identity added and
 * signed with a key derived from the bot token, as Telegram's login widget
 * does ("Checking authorization"). The site holds only that key, never the
 * token. Only a recent login counts.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** How old a login may be: Telegram stamps it when the button is tapped. */
export const telegramLoginMaxAgeMs = 2 * 60_000;

export type TelegramLoginCheck =
  | { ok: true; telegramUserId: number; hash: string }
  | { ok: false; reason: "missing" | "signature" | "stale" };

/** The key Telegram signs logins with: SHA-256 of the bot token, in hex. */
export const telegramLoginKey = (botToken: string) =>
  createHash("sha256").update(botToken).digest("hex");

/** Checks a login's signed fields (everything but `hash`, and our own `next`). */
export function checkTelegramLogin(
  params: URLSearchParams,
  loginKey: string,
  now = new Date(),
): TelegramLoginCheck {
  const hash = params.get("hash");
  const id = Number(params.get("id"));
  const authDate = Number(params.get("auth_date"));
  if (!hash || !Number.isSafeInteger(id) || !Number.isFinite(authDate))
    return { ok: false, reason: "missing" };
  const fields = [...params.entries()]
    .filter(([name]) => name !== "hash" && name !== "next")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  const expected = createHmac("sha256", Buffer.from(loginKey, "hex"))
    .update(fields)
    .digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "signature" };
  const age = now.getTime() - authDate * 1000;
  // A little clock skew either way is fine.
  if (age > telegramLoginMaxAgeMs || age < -30_000)
    return { ok: false, reason: "stale" };
  return { ok: true, telegramUserId: id, hash };
}
