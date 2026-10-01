import {
  integer,
  pgEnum,
  snakeCase,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { users } from "./users.ts";

/** Run lifecycle (docs/design.md §17); `@winston/db/run-state` moves runs through it. */
export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "capped",
  "parked",
]);

/** A front-of-house turn, or a background agent's task (§1). */
export const runKind = pgEnum("run_kind", ["front", "background"]);

/** What started a background run: the front of house delegating, so far (§1). */
export const runTrigger = pgEnum("run_trigger", ["delegate"]);

/** Reasoning effort for a run's model calls (§6). */
export const runEffort = pgEnum("run_effort", ["low", "medium", "high"]);

/**
 * One agent run: a front-of-house turn (`run_…`), or a background task
 * (`task_…`) that progresses one `run_step` job at a time.
 */
export const runs = snakeCase.table("runs", {
  id: text()
    .primaryKey()
    .$default(() => newId("frontRun")),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: runKind().notNull().default("front"),
  status: runStatus().notNull().default("running"),
  /** Background: what started it; unset when started by hand (`bun run task:start`). */
  triggerType: runTrigger(),
  /** Background: the front-of-house turn that delegated it. */
  parentRunId: text().references((): AnyPgColumn => runs.id, {
    onDelete: "set null",
  }),
  /** Background: the self-contained brief it was started with. */
  brief: text(),
  /** Background: the effort its model calls use, when not the profile's own. */
  effort: runEffort(),
  /** Background: its final answer, or where it got to when capped or failed. */
  result: text(),
  stepCount: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp({ withTimezone: true }),
});
