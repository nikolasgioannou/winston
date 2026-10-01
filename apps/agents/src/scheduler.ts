/**
 * The scheduler (docs/design.md §9 Scheduler in Postgres, §17 Scheduler
 * loop): every few seconds, due schedules, expired triggers and due derived
 * timers become jobs. Jobs do the firing, so the tick stays a few cheap
 * queries.
 *
 * Several `agents` tasks may tick at once. Each tick takes a
 * transaction-level advisory lock and skips if another instance holds it,
 * which saves duplicate work without any leader to keep alive; correctness
 * doesn't depend on it, since the jobs are deduplicated and their handlers
 * are idempotent (a schedule's job names its occurrence).
 */
import type { Db, DbOrTx } from "@winston/db/client";
import { enqueue } from "@winston/db/queue";
import { derivedTimers, triggers } from "@winston/db/schema";
import {
  expireTriggerJob,
  fireDerivedTimerJob,
  fireScheduleJob,
} from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { lockSpaces } from "./lock.ts";
import { startTriggerRun } from "./background/trigger-run.ts";
import type { JobHandler } from "./worker.ts";

/** How often the scheduler looks. */
export const schedulerIntervalMs = 5_000;

/**
 * One tick at `now`: queues a job for each due schedule occurrence, expired
 * trigger and due timer. Returns how many it queued, or undefined if another
 * instance is ticking.
 */
export async function schedulerTick(db: DbOrTx, now: Date = new Date()) {
  return db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${lockSpaces.scheduler}, 0) as locked`,
    );
    if (!lock?.locked) return undefined;

    const due = await tx
      .select({
        id: triggers.id,
        userId: triggers.userId,
        at: triggers.nextFireAt,
      })
      .from(triggers)
      .where(
        and(
          eq(triggers.status, "active"),
          eq(triggers.kind, "schedule"),
          lte(triggers.nextFireAt, now),
          or(
            isNull(triggers.expiresAt),
            lt(triggers.nextFireAt, triggers.expiresAt),
          ),
        ),
      );
    for (const trigger of due) {
      const occurrence = trigger.at?.toISOString() ?? "";
      await enqueue(tx, fireScheduleJob.type, {
        userId: trigger.userId,
        payload: { triggerId: trigger.id, occurrence },
        dedupeKey: fireScheduleJob.dedupeKey(trigger.id, occurrence),
      });
    }

    const expiring = await tx
      .select({ id: triggers.id, userId: triggers.userId })
      .from(triggers)
      .where(and(eq(triggers.status, "active"), lte(triggers.expiresAt, now)));
    for (const trigger of expiring)
      await enqueue(tx, expireTriggerJob.type, {
        userId: trigger.userId,
        payload: { triggerId: trigger.id },
        dedupeKey: expireTriggerJob.dedupeKey(trigger.id),
      });

    const timers = await tx
      .select({ id: derivedTimers.id, userId: triggers.userId })
      .from(derivedTimers)
      .innerJoin(triggers, eq(triggers.id, derivedTimers.triggerId))
      .where(
        and(lte(derivedTimers.fireAt, now), eq(triggers.status, "active")),
      );
    for (const timer of timers)
      await enqueue(tx, fireDerivedTimerJob.type, {
        userId: timer.userId,
        payload: { timerId: timer.id },
        dedupeKey: fireDerivedTimerJob.dedupeKey(timer.id),
      });

    return due.length + expiring.length + timers.length;
  });
}

/** Ticks every `schedulerIntervalMs` until stopped; a failed tick is logged and the next one tries again. */
export function startScheduler(db: Db, logger: Logger) {
  const tick = () => {
    schedulerTick(db).catch((error: unknown) => {
      logger.error({ err: error }, "scheduler tick failed");
    });
  };
  const timer = setInterval(tick, schedulerIntervalMs);
  tick();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

/** `fire_schedule`: fires one occurrence of a schedule (a no-op if it has moved on). */
export const fireScheduleHandler: JobHandler = async ({ job, db, logger }) => {
  const { triggerId, occurrence } = job.payload as {
    triggerId: string;
    occurrence: string;
  };
  const runId = await startTriggerRun(db, {
    triggerId,
    reason: "schedule",
    occurrence: new Date(occurrence),
  });
  logger.info(
    { triggerId, occurrence, runId },
    runId ? "schedule fired" : "schedule had moved on",
  );
};

/** `expire_trigger`: expires a trigger, starting its `on_expire` run if one is due. */
export const expireTriggerHandler: JobHandler = async ({ job, db, logger }) => {
  const { triggerId } = job.payload as { triggerId: string };
  const runId = await startTriggerRun(db, { triggerId, reason: "expire" });
  logger.info({ triggerId, runId }, "trigger expired");
};
