import {
  boolean,
  index,
  jsonb,
  snakeCase,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../ids.ts";
import { tsvector } from "./search.ts";
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
    /**
     * Held back from turns while its media is processed (a file being saved
     * to the VM). Later items wait too, so input stays in order.
     */
    pending: boolean().notNull().default(false),
    /** The run that handled it; unset until then. */
    consumedByRunId: text().references(() => runs.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** History search (§2): every string in the payload (a message's text, an event's fields, a task's report). */
    tsv: tsvector().generatedAlwaysAs(
      () =>
        sql`jsonb_to_tsvector('english'::regconfig, payload, '["string"]') || jsonb_to_tsvector('simple'::regconfig, payload, '["string"]')`,
    ),
  },
  (t) => [
    index().on(t.userId, t.consumedByRunId),
    index().on(t.userId, t.occurredAt),
    index().using("gin", t.tsv),
  ],
);
