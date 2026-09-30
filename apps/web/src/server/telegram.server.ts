import type { DbOrTx } from "@winston/db/client";
import { telegramLinks } from "@winston/db/schema";
import {
  issueLinkToken,
  linkTokenLifetimeMs,
} from "@winston/db/telegram-link-tokens";
import { eq } from "drizzle-orm";
import type { TelegramLinkState } from "./telegram-state";

/**
 * A one-time deep link that opens the bot and links the chat it's opened in
 * to `userId` (docs/design.md §9): `t.me/<bot>?start=<token>`, good for 15
 * minutes.
 */
export async function createDeepLink(
  db: DbOrTx,
  userId: string,
  botUsername: string,
) {
  const issuedAt = Date.now();
  const token = await issueLinkToken(db, userId, new Date(issuedAt));
  return {
    url: `https://t.me/${botUsername}?start=${token}`,
    expiresAt: new Date(issuedAt + linkTokenLifetimeMs).toISOString(),
  };
}

/** The user's linked Telegram chat, or null. */
export async function telegramLinkOf(
  db: DbOrTx,
  userId: string,
): Promise<TelegramLinkState | null> {
  const [link] = await db
    .select({
      username: telegramLinks.username,
      linkedAt: telegramLinks.linkedAt,
    })
    .from(telegramLinks)
    .where(eq(telegramLinks.userId, userId));
  return link
    ? { username: link.username, linkedAt: link.linkedAt.toISOString() }
    : null;
}
