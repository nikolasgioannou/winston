import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
