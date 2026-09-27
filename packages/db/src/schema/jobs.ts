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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users.ts";

/** Job lifecycle (docs/design.md §17). */
export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "done",
  "failed",
]);

/** All asynchronous work. See `src/queue.ts` for how jobs are enqueued and leased. */
export const jobs = snakeCase.table(
  "jobs",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    type: text().notNull(),
    payload: jsonb().notNull().default({}),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    status: jobStatus().notNull().default("queued"),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** While running: when the lease expires and the job becomes leasable again. */
    lockedUntil: timestamp({ withTimezone: true }),
    /** While running: identifies the current lease, so a stale worker can't finish the job. */
    leaseToken: text(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    /** At most one queued job per key (see `enqueue`). */
    dedupeKey: text(),
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("jobs_queued_dedupe_key")
      .on(t.dedupeKey)
      .where(sql`status = 'queued'`),
    index("jobs_queued_run_at")
      .on(t.runAt)
      .where(sql`status = 'queued'`),
    index("jobs_running_locked_until")
      .on(t.lockedUntil)
      .where(sql`status = 'running'`),
  ],
);
