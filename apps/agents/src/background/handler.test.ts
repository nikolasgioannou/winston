import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { jobs, runs } from "@winston/db/schema";
import { insertUser, testDb, truncateAll } from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { eq } from "drizzle-orm";
import { localBlobStore } from "../blobs.ts";
import { lockSpaces, withAdvisoryLock } from "../lock.ts";
import { fakeGateway, httpError, textReply } from "../model/testing.ts";
import { fakeVmClient, testRunTokenSecret } from "../vm/testing.ts";
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
});
