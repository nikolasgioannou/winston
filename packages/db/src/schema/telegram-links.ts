import { bigint, snakeCase, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.ts";

/** The Telegram chat each user talks to Winston in (one per user). */
export const telegramLinks = snakeCase.table("telegram_links", {
  userId: text()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // Telegram ids fit in 52 bits, so they're safe as JavaScript numbers.
  chatId: bigint({ mode: "number" }).notNull().unique(),
  telegramUserId: bigint({ mode: "number" }).notNull(),
  username: text(),
  linkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
