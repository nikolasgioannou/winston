import {
  boolean,
  index,
  jsonb,
  snakeCase,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { connections } from "./connections.ts";
import { users } from "./users.ts";

/**
 * Subscribable events from connected apps (docs/design.md §3, §17 event
 * pipeline), normalized from each provider's change feed and matched against
 * subscriptions. Types and payloads come from the catalog
 * (`@winston/domain/events`).
 */
export const events = snakeCase.table(
  "events",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("event")),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: text().references(() => connections.id, {
      onDelete: "cascade",
    }),
    type: text().notNull(),
    payload: jsonb().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    /** Unique per fact (e.g. the provider's message id and event type), so a resync never repeats one. */
    dedupeKey: text().notNull().unique(),
    /** Caused by Winston's own action (it matches a recent audit-log entry). */
    selfCaused: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.occurredAt)],
);
