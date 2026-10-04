import type { CapabilityMap } from "@winston/domain/connections";
import {
  jsonb,
  pgEnum,
  snakeCase,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { users } from "./users.ts";

export const connectionDomain = pgEnum("connection_domain", [
  "mail",
  "calendar",
]);
export const connectionProvider = pgEnum("connection_provider", [
  "gmail",
  "google_calendar",
  "winston",
]);
export const connectionStatus = pgEnum("connection_status", [
  "ok",
  "expiring",
  "expired",
  "disconnected",
]);

/**
 * A connected account (docs/design.md §12a, §14): one Google account's mail
 * or calendar for one user, or Winston's own mailbox (provider `winston`,
 * with no token or grant of its own). A refresh token is encrypted by the
 * token vault; never return this row as it is (use `toConnectionDto`).
 */
export const connections = snakeCase.table(
  "connections",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("connection")),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    domain: connectionDomain().notNull(),
    provider: connectionProvider().notNull(),
    /** The Google account's address, or Winston's current address. */
    externalEmail: text().notNull(),
    /** The OAuth scopes Google granted. */
    scopes: text().array().notNull().default([]),
    capabilities: jsonb().$type<CapabilityMap>().notNull().default({}),
    /**
     * The refresh token, sealed by the token vault with `{ connectionId }` as
     * context. Deleted once a disconnected connection's grant is dealt with.
     */
    tokenCiphertext: text(),
    /**
     * When Google granted the token; testing-mode grants last 7 days (§12a).
     * For Winston's mailbox, when it was turned on.
     */
    grantedAt: timestamp({ withTimezone: true }).notNull(),
    status: connectionStatus().notNull().default("ok"),
    /** Where incremental sync resumes: a Gmail `historyId` or calendars' `syncToken`s (M7). */
    syncState: jsonb().$type<Record<string, unknown>>(),
    /** When the provider's push watch runs out. */
    watchExpiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Also serves lookups by user, since user_id leads.
    unique().on(t.userId, t.domain, t.externalEmail),
  ],
);

/**
 * Every address a Winston mailbox has had (ead827): its current one (also
 * the connection's `external_email`) and the ones it was changed from, which
 * still deliver. Deleted with the user, after their hashes are retired.
 */
export const mailboxAddresses = snakeCase.table("mailbox_addresses", {
  /** `<name>@runwinston.email`, lowercase. */
  address: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  connectionId: text()
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Addresses of deleted accounts, as SHA-256 hashes: enough to never give
 * one out again (whoever had it may have password resets going there)
 * without keeping the address itself.
 */
export const retiredMailboxAddresses = snakeCase.table(
  "retired_mailbox_addresses",
  {
    addressHash: text().primaryKey(),
    retiredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
);
