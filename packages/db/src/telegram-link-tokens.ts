import { generateToken, hashToken } from "@winston/shared/tokens";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { telegramLinkTokens } from "./schema/index.ts";

/** How long a link token works (docs/design.md, decision #2). */
export const linkTokenLifetimeMs = 15 * 60 * 1000;

/**
 * Telegram's `start` parameter: at most 64 characters of A–Z, a–z, 0–9, `_`
 * and `-` (Bot API, deep linking).
 */
const deepLinkPayload = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether a string can travel as a Telegram deep-link payload. */
export function isLinkTokenFormat(token: string) {
  return deepLinkPayload.test(token);
}

/**
 * Issues a token for linking a Telegram chat to `userId`. The raw token
 * (43 base64url characters) goes in the deep link; only its hash is stored.
 * Expired tokens are deleted along the way.
 */
export async function issueLinkToken(
  db: DbOrTx,
  userId: string,
  now = new Date(),
) {
  const token = generateToken();
  if (!isLinkTokenFormat(token))
    throw new Error("Generated a token Telegram can't carry in a deep link.");
  await db
    .delete(telegramLinkTokens)
    .where(lte(telegramLinkTokens.expiresAt, now));
  await db.insert(telegramLinkTokens).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(now.getTime() + linkTokenLifetimeMs),
  });
  return token;
}

/**
 * Uses a link token: returns the user it links to, or nothing if it's
 * malformed, unknown, expired or already used. One conditional UPDATE marks
 * it used, so a token works exactly once, even when two requests race.
 */
export async function consumeLinkToken(
  db: DbOrTx,
  token: string,
  now = new Date(),
) {
  if (!isLinkTokenFormat(token)) return undefined;
  const [used] = await db
    .update(telegramLinkTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(telegramLinkTokens.tokenHash, hashToken(token)),
        isNull(telegramLinkTokens.usedAt),
        gt(telegramLinkTokens.expiresAt, now),
      ),
    )
    .returning({ userId: telegramLinkTokens.userId });
  return used?.userId;
}
