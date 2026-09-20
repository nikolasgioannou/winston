import { pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

const schema = pgSchema("winston");

export const owners = schema.table("owners", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
