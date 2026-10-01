import {
  bigint,
  index,
  jsonb,
  pgEnum,
  snakeCase,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { connections } from "./connections.ts";
import { runs } from "./runs.ts";
import { users } from "./users.ts";

/**
 * A write's outcome. It's `pending` from just before the provider is called,
 * so a change the provider reports back (a push notification) can be matched
 * to Winston's own action even before the call returns (M7, `self_caused`).
 */
export const auditOutcome = pgEnum("audit_outcome", ["pending", "ok", "error"]);

/**
 * Everything Winston changes in a connected app (docs/design.md §5, §14): one
 * row per write, never per read. The request is a redacted summary (bodies
 * become their length), enough to say what was done without keeping content.
 */
export const auditLog = snakeCase.table(
  "audit_log",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: text().references(() => runs.id, { onDelete: "set null" }),
    connectionId: text().references(() => connections.id, {
      onDelete: "set null",
    }),
    /** What was done, as `<domain>.<verb>`: `mail.send`, `calendar.rsvp`. */
    action: text().notNull(),
    /** What it was done to: a CLI id (`msg_…`, `evt_…`) or a provider id once known. */
    targetRef: text(),
    /** One line, for people: "Replied to Dana Reyes: Re: Lease renewal". */
    summary: text().notNull(),
    request: jsonb().$type<Record<string, unknown>>().notNull(),
    outcome: auditOutcome().notNull().default("pending"),
    /** The provider's error, when the outcome is `error`. */
    error: text(),
    /** The provider's id for what was created or changed, once known. */
    resultRef: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.userId, t.createdAt),
    // Matching provider changes to Winston's own writes (M7).
    index().on(t.connectionId, t.createdAt),
  ],
);
