import { snakeCase, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Telegram login hashes already used to sign in (docs/design.md §13): a
 * login button's signed data has no nonce, so each hash works once. Kept a
 * day, well past the two minutes a login is accepted for.
 */
export const telegramLogins = snakeCase.table("telegram_logins", {
  hash: text().primaryKey(),
  usedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
