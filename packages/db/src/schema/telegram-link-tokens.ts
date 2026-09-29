import { snakeCase, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.ts";

/**
 * One-time tokens that link a Telegram chat to an account through a deep
 * link (`t.me/<bot>?start=<token>`, docs/design.md §4, decision #2). Only the
 * hash is stored; a token works once, before it expires.
 */
export const telegramLinkTokens = snakeCase.table("telegram_link_tokens", {
  tokenHash: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
});
