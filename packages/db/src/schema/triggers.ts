import { triggerKinds, triggerStatuses } from "@winston/domain/triggers";
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  snakeCase,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { connections } from "./connections.ts";
import { runs } from "./runs.ts";
import { users } from "./users.ts";

export const triggerKind = pgEnum("trigger_kind", triggerKinds);
export const triggerStatus = pgEnum("trigger_status", triggerStatuses);
export const triggerBatchStatus = pgEnum("trigger_batch_status", [
  "pending",
  "fired",
]);

/**
 * What wakes Winston up (docs/design.md §3): schedules (one-off `at`, or
 * recurring `cron` in the user's time zone) and subscriptions to catalog
 * events, each with a note to his future self. Lifecycle rules are pure
 * functions in `@winston/domain/triggers`.
 */
export const triggers = snakeCase.table(
  "triggers",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("trigger")),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: triggerKind().notNull(),
    /** A one-off schedule's time. */
    at: timestamp({ withTimezone: true }),
    /** A recurring schedule's 5-field cron, in the user's time zone. */
    cron: text(),
    /** A subscription's catalog event type. */
    eventType: text(),
    /** The account a subscription listens to; all of the domain's when unset. */
    connectionId: text().references(() => connections.id, {
      onDelete: "cascade",
    }),
    /** One object it's scoped to: a `thr_` or `evt_` id. */
    scopeRef: text(),
    /** Structured filter fields, by the catalog's names (`from`, `attendee`, …). */
    filter: jsonb().notNull().default({}),
    /** A provider-native query (Gmail search syntax), checked by the provider. */
    nativeQuery: text(),
    /** For `calendar.event.starting`: how long before. */
    leadMinutes: integer(),
    note: text().notNull(),
    /** Null for unlimited. */
    maxFires: integer(),
    fireCount: integer().notNull().default(0),
    expiresAt: timestamp({ withTimezone: true }),
    onExpireNote: text(),
    /** A schedule's next time; null for subscriptions and spent schedules. */
    nextFireAt: timestamp({ withTimezone: true }),
    status: triggerStatus().notNull().default("active"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("triggers_due")
      .on(t.nextFireAt)
      .where(sql`status = 'active'`),
    index("triggers_expiring")
      .on(t.expiresAt)
      .where(sql`status = 'active'`),
    index().on(t.userId, t.status),
    index("triggers_subscriptions")
      .on(t.userId, t.eventType)
      .where(sql`status = 'active' and kind = 'subscription'`),
  ],
);

/**
 * Events waiting to fire a subscription together: a batch fires 30 s after
 * its first event (§3), so a burst becomes one run.
 */
export const triggerBatches = snakeCase.table(
  "trigger_batches",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    triggerId: text()
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    eventIds: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** The first event's time plus 30 s. */
    fireAt: timestamp({ withTimezone: true }).notNull(),
    /** The background run it started, once fired. */
    runId: text().references(() => runs.id, { onDelete: "set null" }),
    status: triggerBatchStatus().notNull().default("pending"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one pending batch per trigger collects events.
    uniqueIndex("trigger_batches_pending")
      .on(t.triggerId)
      .where(sql`status = 'pending'`),
  ],
);

/**
 * Materialized `calendar.event.starting` timers (§3, abstractions): one per
 * subscription and event, recomputed whenever the event moves or is
 * cancelled.
 */
export const derivedTimers = snakeCase.table(
  "derived_timers",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    triggerId: text()
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    /** The calendar event (`evt_`). */
    ref: text().notNull(),
    fireAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.triggerId, t.ref), index().on(t.fireAt)],
);
