import {
  bigint,
  index,
  numeric,
  pgEnum,
  snakeCase,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { runs } from "./runs.ts";
import { users } from "./users.ts";

/** What a charge was for: model calls, speech-to-text, Jev, the user's computer, or their sites. */
export const costCategory = pgEnum("cost_category", [
  "model",
  "stt",
  "jev",
  "vm",
  "hosting",
]);

/** One row per charge, so spend is a sum over this table. */
export const costLedger = snakeCase.table(
  "cost_ledger",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: text().references(() => runs.id, { onDelete: "set null" }),
    category: costCategory().notNull(),
    costUsd: numeric({ precision: 12, scale: 6 }).notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.occurredAt)],
);
