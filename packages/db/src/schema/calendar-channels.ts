import { index, snakeCase, text, timestamp } from "drizzle-orm/pg-core";
import { connections } from "./connections.ts";

/**
 * Google Calendar push channels (docs/design.md §3): one per watched
 * calendar of a connection, renewed before they expire. Notifications carry
 * the channel's id and token; only the token's hash is kept.
 */
export const calendarChannels = snakeCase.table(
  "calendar_channels",
  {
    /** The channel id we chose (a UUID); notifications name it. */
    id: text().primaryKey(),
    connectionId: text()
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    calendarId: text().notNull(),
    /** Google's id for the watched resource, needed to stop the channel. */
    resourceId: text().notNull(),
    /** SHA-256 of the channel token, in hex. */
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.connectionId)],
);
