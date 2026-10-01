import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import type { Job } from "@winston/db/queue";
import { jobs, runs, triggers } from "@winston/db/schema";
import {
  inRollback,
  insertUser,
  testDb,
  truncateAll,
} from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { and, eq } from "drizzle-orm";
import {
  expireTriggerHandler,
  fireScheduleHandler,
  schedulerTick,
} from "./scheduler.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

async function trigger(
  tx: DbOrTx,
  values: Partial<typeof triggers.$inferInsert>,
) {
  const user = await insertUser(tx, { timezone: "America/New_York" });
  const [row] = await tx
    .insert(triggers)
    .values({ userId: user.id, kind: "schedule", note: "Do it.", ...values })
    .returning();
  if (!row) throw new Error("no trigger");
  return row;
}

const queued = (tx: DbOrTx, type: string) =>
  tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, type), eq(jobs.status, "queued")));

/** Runs a job's handler as the worker would. */
const handle = (tx: DbOrTx, handler: typeof fireScheduleHandler, job: Job) =>
  handler({
    job,
    db: tx as never,
    logger,
    extendLease: () => Promise.resolve(true),
  });

const runsOf = (tx: DbOrTx, triggerId: string) =>
  tx.select().from(runs).where(eq(runs.triggerId, triggerId));

describe("scheduler", () => {
  test("a due one-off becomes one job, fires once, and is spent", async () => {
    await inRollback(db, async (tx) => {
      const at = new Date("2026-10-02T18:45:00Z");
      const row = await trigger(tx, { at, nextFireAt: at, maxFires: 1 });
      expect(await schedulerTick(tx, new Date("2026-10-02T18:44:59Z"))).toBe(0);
      expect(await schedulerTick(tx, new Date("2026-10-02T18:45:01Z"))).toBe(1);
      const [job] = await queued(tx, "fire_schedule");
      if (!job) throw new Error("no job");
      expect(job.payload).toEqual({
        triggerId: row.id,
        occurrence: "2026-10-02T18:45:00.000Z",
      });
      await handle(tx, fireScheduleHandler, job);
      expect(await runsOf(tx, row.id)).toHaveLength(1);
      const [after] = await tx
        .select()
        .from(triggers)
        .where(eq(triggers.id, row.id));
      expect(after).toMatchObject({
        status: "exhausted",
        fireCount: 1,
        nextFireAt: null,
      });
      // A duplicate job for the same occurrence does nothing.
      await handle(tx, fireScheduleHandler, job);
      expect(await runsOf(tx, row.id)).toHaveLength(1);
    });
  });

  test("after downtime, a cron fires once and moves to its next future time", async () => {
    await inRollback(db, async (tx) => {
      const missed = new Date("2020-01-06T13:00:00Z");
      const row = await trigger(tx, {
        cron: "0 8 * * 1-5",
        nextFireAt: missed,
      });
      await schedulerTick(tx, new Date());
      const pending = await queued(tx, "fire_schedule");
      expect(pending).toHaveLength(1);
      await handle(tx, fireScheduleHandler, pending[0] as Job);
      const [after] = await tx
        .select()
        .from(triggers)
        .where(eq(triggers.id, row.id));
      expect(after?.fireCount).toBe(1);
      expect(after?.nextFireAt?.getTime()).toBeGreaterThan(Date.now());
      expect(await runsOf(tx, row.id)).toHaveLength(1);
    });
  });

  test("expiry: with an on_expire note a run starts; without one the trigger just expires", async () => {
    await inRollback(db, async (tx) => {
      // The handler expires by the real clock, so this expiry has passed.
      const expiresAt = new Date(Date.now() - 60_000);
      const subscription = {
        kind: "subscription" as const,
        eventType: "mail.message.received",
        maxFires: 1,
        expiresAt,
      };
      const noted = await trigger(tx, {
        ...subscription,
        onExpireNote: "Dana never replied.",
      });
      const plain = await trigger(tx, subscription);
      expect(await schedulerTick(tx)).toBe(2);
      for (const job of await queued(tx, "expire_trigger"))
        await handle(tx, expireTriggerHandler, job);
      expect(await runsOf(tx, noted.id)).toHaveLength(1);
      expect(await runsOf(tx, plain.id)).toHaveLength(0);
      const statuses = await tx
        .select({ status: triggers.status })
        .from(triggers);
      expect(statuses.map((s) => s.status)).toEqual(["expired", "expired"]);
    });
  });

  test("a schedule due after it expires doesn't fire", async () => {
    await inRollback(db, async (tx) => {
      await trigger(tx, {
        cron: "0 8 * * *",
        nextFireAt: new Date("2026-10-10T12:00:00Z"),
        expiresAt: new Date("2026-10-10T11:00:00Z"),
      });
      await schedulerTick(tx, new Date("2026-10-10T12:00:01Z"));
      expect(await queued(tx, "fire_schedule")).toHaveLength(0);
      expect(await queued(tx, "expire_trigger")).toHaveLength(1);
    });
  });
});

describe("scheduler across instances", () => {
  beforeEach(() => truncateAll(db));
  afterAll(() => truncateAll(db));

  test("ticks at once queue one job, and only one run starts", async () => {
    const at = new Date(Date.now() - 1_000);
    const row = await trigger(db, { at, nextFireAt: at, maxFires: 1 });
    await Promise.all([
      schedulerTick(db),
      schedulerTick(db),
      schedulerTick(db),
    ]);
    const pending = await queued(db, "fire_schedule");
    expect(pending).toHaveLength(1);
    const job = pending[0] as Job;
    await Promise.all([
      handle(db, fireScheduleHandler, job),
      handle(db, fireScheduleHandler, job),
    ]);
    expect(await runsOf(db, row.id)).toHaveLength(1);
  });
});
