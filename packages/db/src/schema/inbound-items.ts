import { index, jsonb, snakeCase, text, timestamp } from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { runs } from "./runs.ts";
import { users } from "./users.ts";

/**
 * Everything that reaches an agent: user messages, reactions, events. `payload`
 * is structured data; envelopes are rendered from it at read time, never stored.
 */
export const inboundItems = snakeCase.table(
  "inbound_items",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("historyItem")),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `user_message`, `telegram.reaction.added`, or an event type. */
    type: text().notNull(),
    payload: jsonb().notNull(),
    /** Where it came from (e.g. a Telegram update id), unique so redeliveries are ignored. */
    sourceRef: text().unique(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    /** The run that handled it; unset until then. */
    consumedByRunId: text().references(() => runs.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.consumedByRunId)],
);
