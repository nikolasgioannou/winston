import { snakeCase, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.ts";

/**
 * Sign-ins for the browser page's socket to the gateway (docs/design.md §5,
 * §13): the page asks its own server for one, which works once, within a
 * minute. The site's session cookie never reaches the gateway's host, and
 * the two services share the database, not a secret. Only hashes are stored.
 */
export const viewerTickets = snakeCase.table("viewer_tickets", {
  tokenHash: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});
