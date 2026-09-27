import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  complete,
  enqueue,
  extendLease,
  fail,
  lease,
  retryDelayMs,
} from "./queue.ts";
import { jobs } from "./schema/index.ts";
import { inRollback, testDb, truncateAll } from "./testing.ts";

const db = await testDb();
const types = ["demo"] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("retryDelayMs", () => {
  test("doubles per attempt, capped at five minutes, with 50–100% jitter", () => {
    expect(retryDelayMs(1, () => 1)).toBe(1_000);
    expect(retryDelayMs(3, () => 1)).toBe(4_000);
    expect(retryDelayMs(3, () => 0)).toBe(2_000);
    expect(retryDelayMs(30, () => 1)).toBe(300_000);
  });
});

describe("enqueue", () => {
  test("inside a rolled-back transaction leaves no job", async () => {
    await inRollback(db, async (tx) => {
      await enqueue(tx, "rolled-back");
    });
    expect(
      await db.select().from(jobs).where(eq(jobs.type, "rolled-back")),
    ).toEqual([]);
  });

  describe("with a dedupe key", () => {
    beforeEach(() => truncateAll(db));

    test("ignores a duplicate of a queued job", async () => {
      const first = await enqueue(db, "demo", {
        dedupeKey: "k",
        payload: { n: 1 },
      });
      const second = await enqueue(db, "demo", {
        dedupeKey: "k",
        payload: { n: 2 },
      });
      expect(second).toBe(first);
      const rows = await db.select().from(jobs);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toEqual({ n: 1 });
    });

    test("reschedule moves the queued job's run time", async () => {
      const soon = new Date(Date.now() + 1_000);
      const later = new Date(Date.now() + 60_000);
      const id = await enqueue(db, "demo", {
        dedupeKey: "k",
        runAt: soon,
        onDuplicate: "reschedule",
      });
      expect(
        await enqueue(db, "demo", {
          dedupeKey: "k",
          runAt: later,
          onDuplicate: "reschedule",
        }),
      ).toBe(id);
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
      expect(row?.runAt.getTime()).toBe(later.getTime());
    });

    test("a key frees up once its job is running", async () => {
      const first = await enqueue(db, "demo", { dedupeKey: "k" });
      await lease(db, { types, leaseMs: 60_000 });
      const second = await enqueue(db, "demo", { dedupeKey: "k" });
      expect(second).not.toBe(first);
    });
  });
});

describe("lease", () => {
  beforeEach(() => truncateAll(db));

  test("takes due jobs of the requested types only", async () => {
    await enqueue(db, "other");
    await enqueue(db, "demo", { runAt: new Date(Date.now() + 60_000) });
    const due = await enqueue(db, "demo");
    const leased = await lease(db, { types, leaseMs: 60_000, limit: 10 });
    expect(leased.map((l) => l.job.id)).toEqual([due]);
    expect(leased[0]?.job).toMatchObject({ status: "running", attempts: 1 });
  });

  test("concurrent workers never lease the same job", async () => {
    for (let i = 0; i < 20; i += 1)
      await enqueue(db, "demo", { payload: { i } });
    const batches = await Promise.all(
      Array.from({ length: 4 }, () =>
        lease(db, { types, leaseMs: 60_000, limit: 8 }),
      ),
    );
    const ids = batches.flat().map((l) => l.job.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  test("an expired lease is re-leased, and the stale worker can't finish the job", async () => {
    await enqueue(db, "demo");
    const [stale] = await lease(db, { types, leaseMs: 50 });
    expect(await lease(db, { types, leaseMs: 60_000 })).toEqual([]);
    await sleep(100);

    const [fresh] = await lease(db, { types, leaseMs: 60_000 });
    expect(fresh?.job.id).toBe(stale?.job.id ?? -1);
    expect(fresh?.job.attempts).toBe(2);
    if (!stale || !fresh) throw new Error("expected both leases");
    expect(await complete(db, stale)).toBe(false);
    expect(await extendLease(db, stale, 60_000)).toBe(false);
    expect(await complete(db, fresh)).toBe(true);
    const [row] = await db.select().from(jobs);
    expect(row?.status).toBe("done");
  });

  test("extendLease keeps a long job from being re-leased", async () => {
    await enqueue(db, "demo");
    const [held] = await lease(db, { types, leaseMs: 50 });
    if (!held) throw new Error("expected a lease");
    expect(await extendLease(db, held, 60_000)).toBe(true);
    await sleep(100);
    expect(await lease(db, { types, leaseMs: 60_000 })).toEqual([]);
  });
});

describe("fail", () => {
  beforeEach(() => truncateAll(db));

  test("retries after a backoff, then gives up at max attempts", async () => {
    await enqueue(db, "demo", { maxAttempts: 2 });

    const [first] = await lease(db, { types, leaseMs: 60_000 });
    if (!first) throw new Error("expected a lease");
    expect(await fail(db, first, new Error("boom 1"))).toBe(true);
    let [row] = await db.select().from(jobs);
    expect(row).toMatchObject({
      status: "queued",
      lastError: "boom 1",
      attempts: 1,
    });
    expect(row?.runAt.getTime()).toBeGreaterThan(Date.now() + 400);
    expect(await lease(db, { types, leaseMs: 60_000 })).toEqual([]);

    await db.update(jobs).set({ runAt: sql`now()` });
    const [second] = await lease(db, { types, leaseMs: 60_000 });
    if (!second) throw new Error("expected a lease");
    expect(await fail(db, second, "boom 2")).toBe(true);
    [row] = await db.select().from(jobs);
    expect(row).toMatchObject({
      status: "failed",
      lastError: "boom 2",
      attempts: 2,
    });
    expect(await lease(db, { types, leaseMs: 60_000 })).toEqual([]);
  });
});
