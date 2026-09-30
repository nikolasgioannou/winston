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
]);
export const connectionStatus = pgEnum("connection_status", [
  "ok",
  "expiring",
  "expired",
  "disconnected",
]);

/**
 * A connected account (docs/design.md §12a, §14): one Google account's mail
 * or calendar for one user. Its refresh token is encrypted by the token
 * vault; never return this row as it is (use `toConnectionDto`).
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
    /** The Google account's address. */
    externalEmail: text().notNull(),
    /** The user's name for it, like `work`, as in `mail:work` (`aliasPattern`). */
    alias: text(),
    /** The OAuth scopes Google granted. */
    scopes: text().array().notNull().default([]),
    capabilities: jsonb().$type<CapabilityMap>().notNull().default({}),
    /**
     * The refresh token, sealed by the token vault with `{ connectionId }` as
     * context. Deleted once a disconnected connection's grant is dealt with.
     */
    tokenCiphertext: text(),
    /** When Google granted the token; testing-mode grants last 7 days (§12a). */
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
    // Winston picks an account by alias (`--account work`).
    unique().on(t.userId, t.domain, t.alias),
  ],
);
