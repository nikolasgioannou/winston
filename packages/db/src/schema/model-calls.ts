import {
  bigint,
  index,
  integer,
  numeric,
  snakeCase,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { promptVersions } from "./prompt-versions.ts";
import { runs } from "./runs.ts";

/**
 * One row per model call. Together with `run_messages` (which holds the
 * messages themselves), any run can be reconstructed. The rendered request
 * isn't stored: it's rebuilt from the prompt version and the message range.
 */
export const modelCalls = snakeCase.table(
  "model_calls",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: text()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    step: integer().notNull(),
    model: text().notNull(),
    provider: text().notNull(),
    promptHash: text()
      .notNull()
      .references(() => promptVersions.hash),
    /** The `run_messages.id` range that formed the context. */
    contextFromMessageId: bigint({ mode: "number" }).notNull(),
    contextToMessageId: bigint({ mode: "number" }).notNull(),
    /** Long tool output before this message id was shortened (the front's window); 0 means none was. */
    contextStubBeforeMessageId: bigint({ mode: "number" }).notNull().default(0),
    inputTokens: integer().notNull(),
    cachedTokens: integer().notNull(),
    cacheWriteTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    reasoningTokens: integer().notNull(),
    costUsd: numeric({ precision: 12, scale: 6 }).notNull(),
    latencyMs: integer().notNull(),
    stopReason: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.runId)],
);
