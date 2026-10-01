import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { jobs, runs } from "@winston/db/schema";
import { insertUser, testDb, truncateAll } from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { and, eq } from "drizzle-orm";
import { localBlobStore } from "../blobs.ts";
import { lockSpaces, withAdvisoryLock } from "../lock.ts";
import { fakeGateway, httpError, textReply } from "../model/testing.ts";
import { fakeVmClient, testRunTokenSecret } from "../vm/testing.ts";
import { createWorker } from "../worker.ts";
import { runStepHandler } from "./handler.ts";
import { startBackgroundRun } from "./run.ts";

// Advisory locks need real connections, so these tests use the database directly.
const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

beforeEach(() => truncateAll(db));
// Leave nothing behind for other test files, which roll back instead.
afterAll(() => truncateAll(db));

async function job(replies: Record<string, unknown>[]) {
  const user = await insertUser(db);
  const runId = await startBackgroundRun(db, {
    userId: user.id,
    brief: "Do it.",
  });
  const [queued] = await db.select().from(jobs).where(eq(jobs.userId, user.id));
  if (!queued) throw new Error("no job");
  const fake = fakeGateway({ replies });
  const handler = runStepHandler({
    gateway: fake.gateway,
    vm: fakeVmClient().client,
    runTokenSecret: testRunTokenSecret,
    blobs: localBlobStore(`${tmpdir()}/winston-test-blobs`),
    retryDelayMs: 0,
  });
  const run = (attempts: number) =>
    handler({
      job: { ...queued, attempts },
      db,
      logger,
      extendLease: () => Promise.resolve(true),
    });
  const status = async () =>
    (await db.select().from(runs).where(eq(runs.id, runId)))[0];
  return { runId, run, status, requests: fake.requests };
}

/** The message a promise rejects with (failing the test if it doesn't). */
async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  return error instanceof Error ? error.message : "";
}

describe("the run_step job", () => {
  test("runs a step under the run's lock", async () => {
    const { run, status } = await job([textReply("Done.")]);
    await run(1);
    expect((await status())?.status).toBe("completed");
  });

  test("leaves the step to whoever holds the run's lock", async () => {
    const { runId, run, requests } = await job([textReply("Done.")]);
    await withAdvisoryLock(db, lockSpaces.runStep, runId, () => run(1));
    expect(requests).toHaveLength(0);
  });

  test("a failure is retried by the queue; the last attempt fails the run with the reason", async () => {
    const { run, status } = await job([httpError(500)]);
    expect(await failure(run(1))).toContain("");
    expect((await status())?.status).toBe("running");
    expect(await failure(run(12))).toContain("");
    const failed = await status();
    expect(failed?.status).toBe("failed");
    expect(failed?.result).toStartWith("The task failed:");
  });

  test("stopping the worker lets the in-flight step finish and checkpoint", async () => {
    const user = await insertUser(db);
    const runId = await startBackgroundRun(db, {
      userId: user.id,
      brief: "Do it.",
    });
    let started: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fake = fakeGateway({
      replies: [textReply("Done.")],
      delayMs: 300,
      onRequest: () => {
        started();
        return Promise.resolve();
      },
    });
    const worker = createWorker({
      db,
      logger,
      handlers: {
        run_step: runStepHandler({
          gateway: fake.gateway,
          vm: fakeVmClient().client,
          runTokenSecret: testRunTokenSecret,
          blobs: localBlobStore(`${tmpdir()}/winston-test-blobs`),
        }),
      },
      concurrency: 2,
      idleMs: 20,
    });
    worker.start();
    await inFlight;
    await worker.stop();
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run).toMatchObject({ status: "completed", result: "Done." });
    const [step] = await db
      .select({ status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.userId, user.id), eq(jobs.type, "run_step")));
    expect(step?.status).toBe("done");
  });
});
