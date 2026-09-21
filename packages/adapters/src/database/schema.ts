import { integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { EventPayload } from "@winston/contracts/events";

const schema = pgSchema("winston");

export const owners = schema.table("owners", {
  id: uuid("id").primaryKey(),
  timezone: text("timezone").notNull().default("UTC"),
  timezoneRevision: integer("timezone_revision").notNull().default(0),
  timezoneObservedAt: timestamp("timezone_observed_at", { withTimezone: true }),
  timezoneSource: text("timezone_source")
    .$type<"default" | "browser">()
    .notNull()
    .default("default"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = schema.table(
  "events",
  {
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    id: text("id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<EventPayload>().notNull(),
    destinations: jsonb("destinations").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.id] })],
);

export const outbox = schema.table(
  "outbox",
  {
    ownerId: uuid("owner_id").notNull(),
    eventId: text("event_id").notNull(),
    destination: text("destination").notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failureCode: text("failure_code").$type<"delivery-failed">(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.eventId, table.destination] })],
);

export const eventReceipts = schema.table(
  "event_receipts",
  {
    ownerId: uuid("owner_id").notNull(),
    eventId: text("event_id").notNull(),
    consumer: text("consumer").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.eventId, table.consumer] })],
);
