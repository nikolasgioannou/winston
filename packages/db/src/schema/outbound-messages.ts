import { bigint, snakeCase, text, timestamp } from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { runs } from "./runs.ts";
import { users } from "./users.ts";

/** Messages Winston sent to the user. */
export const outboundMessages = snakeCase.table("outbound_messages", {
  id: text()
    .primaryKey()
    .$default(() => newId("historyItem")),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  runId: text()
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  text: text().notNull(),
  /** Telegram ids of the message(s) this was delivered as (long text is split). */
  telegramMessageIds: bigint({ mode: "number" }).array().notNull().default([]),
  sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
