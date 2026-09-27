import { beforeEach, describe, expect, test } from "bun:test";
import { enqueue } from "@winston/db/queue";
import { jobs } from "@winston/db/schema";
import { testDb, truncateAll } from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { eq } from "drizzle-orm";
import { createWorker, type JobHandler } from "./worker.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  level: "fatal",
  destination: { write: () => undefined },
});

function start(handlers: Record<string, JobHandler>, concurrency = 2) {
  const worker = createWorker({
    db,
    logger,
    handlers,
    concurrency,
    idleMs: 20,
  });
  worker.start();
  return worker;
}

async function until(check: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const statusOf = async (id: number) =>
  (await db.select().from(jobs).where(eq(jobs.id, id)))[0]?.status;

beforeEach(() => truncateAll(db));

describe("createWorker", () => {
  test("runs a job's handler and marks it done", async () => {
    const seen: unknown[] = [];
    const worker = start({
      noop: async ({ job }) => {
        seen.push(job.payload);
        await Promise.resolve();
      },
    });
    const id = await enqueue(db, "noop", { payload: { hello: "world" } });
    await until(async () => (await statusOf(id)) === "done");
    await worker.stop();
    expect(seen).toEqual([{ hello: "world" }]);
  });

  test("stop() lets the in-flight job finish and leases nothing new", async () => {
    let release: () => void = () => undefined;
    let started = false;
    const worker = start({
      slow: async () => {
        started = true;
        await new Promise<void>((resolve) => (release = resolve));
      },
    });
    const first = await enqueue(db, "slow");
    await until(() => Promise.resolve(started));

    const stopped = worker.stop();
    const second = await enqueue(db, "slow");
    release();
    await stopped;

    expect(await statusOf(first)).toBe("done");
    expect(await statusOf(second)).toBe("queued");
  });

  test("a throwing handler records the failure for a retry", async () => {
    const worker = start({
      broken: () => Promise.reject(new Error("kaboom")),
    });
    const id = await enqueue(db, "broken");
    await until(
      async () =>
        (await db.select().from(jobs).where(eq(jobs.id, id)))[0]?.lastError ===
        "kaboom",
    );
    await worker.stop();
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
  });

  test("never runs more than `concurrency` jobs at once", async () => {
    let running = 0;
    let peak = 0;
    const worker = start(
      {
        work: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 30));
          running -= 1;
        },
      },
      2,
    );
    const ids: number[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await enqueue(db, "work"));
    await until(async () =>
      (await Promise.all(ids.map(statusOf))).every((s) => s === "done"),
    );
    await worker.stop();
    expect(peak).toBe(2);
  });

  test("ignores job types it has no handler for", async () => {
    const worker = start({ noop: () => Promise.resolve() });
    const other = await enqueue(db, "someone-else");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await worker.stop();
    expect(await statusOf(other)).toBe("queued");
  });
});
