import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createJobRuntime } from "@winston/adapters/jobs";
import { withTestPostgres } from "../../src/postgres";

async function until(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  assert.fail("Job runtime did not reach the expected state.");
}

test("conversation capacity stays available during background saturation and failures remain inspectable", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    const runtime = createJobRuntime({
      directConnectionString: connectionString,
      onNotice: () => {},
    });
    const ownerId = randomUUID();
    const reference = { ownerId, referenceId: "conversation-1", revision: 1 };
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let replies = 0;
    try {
      await runtime.start();
      await runtime.work("background", async () => {
        started += 1;
        await blocked;
      });
      await runtime.work("conversation", async () => {
        replies += 1;
        await Promise.resolve();
      });
      await runtime.enqueue("background", { ...reference, referenceId: "background-1" });
      await runtime.enqueue("background", { ...reference, referenceId: "background-2" });
      await until(() => Promise.resolve(started === 2));
      const id = await runtime.enqueue("conversation", reference);
      assert.equal(await runtime.enqueue("conversation", reference), id);
      await until(
        async () => (await runtime.inspect("conversation", reference))?.state === "completed",
      );
      assert.equal(replies, 1);
      assert.equal(started, 2);
      assert.equal(
        await runtime.inspect("conversation", { ...reference, ownerId: randomUUID() }),
        undefined,
      );
      release();

      await runtime.work("maintenance", async () => {
        await Promise.resolve();
        throw new Error("sensitive provider detail");
      });
      const failed = { ...reference, referenceId: "failure" };
      await runtime.enqueue("maintenance", failed);
      // Exponential retry jitter plus notification-fallback polling can exceed twenty seconds.
      await until(
        async () => (await runtime.inspect("maintenance", failed))?.terminalFailure === true,
        60_000,
      );
      const result = await runtime.inspect("maintenance", failed);
      assert.equal(result?.retries, 3);
      const dead = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'winston-failed'`;
      assert.equal(dead[0]?.count, 1);
      const errors = await sql<
        { output: unknown }[]
      >`SELECT output FROM pgboss.job WHERE name = 'winston-maintenance'`;
      assert.equal(JSON.stringify(errors).includes("sensitive provider detail"), false);

      const queued = { ...reference, referenceId: "persistent" };
      await runtime.enqueue("transcription", queued);
      await runtime.stop();
      await runtime.start();
      await runtime.work("transcription", () => Promise.resolve());
      await until(
        async () => (await runtime.inspect("transcription", queued))?.state === "completed",
      );
    } finally {
      release();
      await runtime.stop();
    }
  });
});
