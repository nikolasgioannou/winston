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
} from "drizzle-orm/pg-core";
import { runs } from "./runs.ts";

/**
 * The append-only message log of every run: both the checkpoint a run resumes
 * from and the record of what happened. `id` increases across all runs, so a
 * user's front-of-house messages read as one stream in `id` order (the rolling
 * window starts at `front_state.window_start_message_id`).
 */
/**
 * A message the model saw, or a background run's compaction: the summary that
 * stands in for everything before it but the last few steps (§2).
 */
export const runMessageKind = pgEnum("run_message_kind", [
  "message",
  "compaction",
]);

export const runMessages = snakeCase.table(
  "run_messages",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: text()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Position within the run, from 0. */
    seq: integer().notNull(),
    kind: runMessageKind().notNull().default("message"),
    role: text().notNull(),
    /** An AI SDK `ModelMessage`. */
    content: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.runId, t.seq), index().on(t.runId)],
);
