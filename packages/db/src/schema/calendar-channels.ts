import {
  index,
  jsonb,
  primaryKey,
  snakeCase,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
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

/**
 * The last seen state of each calendar event a connection syncs (docs/design.md
 * §3, §14): what `calendar.event.updated` diffs against, and what a
 * cancellation (which arrives with almost nothing) is reported from.
 */
export const calendarEventSnapshots = snakeCase.table(
  "calendar_event_snapshots",
  {
    connectionId: text()
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** `<calendar id>/<event id>`, as the provider names it. */
    providerId: text().notNull(),
    /** The diffed fields: title, times, place, description, attendees and answers, video link, organizer. */
    snapshot: jsonb().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.providerId] })],
);
