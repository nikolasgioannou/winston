import {
  integer,
  pgEnum,
  snakeCase,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { triggers } from "./triggers.ts";
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

/**
 * What started a background run (§1, §3): the front of house delegating, or
 * one of Winston's triggers (a schedule, events, or an expiry).
 */
export const runTrigger = pgEnum("run_trigger", [
  "delegate",
  "schedule",
  "event",
  "expire",
]);

/** Reasoning effort for a run's model calls (§6). */
export const runEffort = pgEnum("run_effort", [
  "low",
  "medium",
  "high",
  "xhigh",
]);

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
  /** Background: the trigger that fired it. */
  triggerId: text().references((): AnyPgColumn => triggers.id, {
    onDelete: "set null",
  }),
  /** Background: the front-of-house turn that delegated it. */
  parentRunId: text().references((): AnyPgColumn => runs.id, {
    onDelete: "set null",
  }),
  /** Background: the self-contained brief it was started with. */
  brief: text(),
  /** Background: the effort its model calls use, when not the profile's own; the run can raise it. */
  effort: runEffort(),
  /** Background: its final answer, or where it got to when capped or failed. */
  result: text(),
  /** Background, while parked: what it's waiting for the user to do. */
  waitingFor: text(),
  /** Background: cancelling was asked for; the run stops at its next step boundary. */
  cancelRequestedAt: timestamp({ withTimezone: true }),
  stepCount: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp({ withTimezone: true }),
});
