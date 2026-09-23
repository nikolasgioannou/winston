import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, startTaskSignals } from "@winston/adapters/database";
import { createBackgroundStep } from "@winston/server/background";
import { withTestPostgres } from "../../src/postgres";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  assert.fail("Task notification did not arrive.");
}

test("task notifications broadcast committed revisions, isolate owners and recover disconnects", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    let disconnects = 0;
    const options = {
      directConnectionString: connectionString,
      onDisconnect: () => {
        disconnects += 1;
      },
    };
    const first = await startTaskSignals(options);
    const second = await startTaskSignals(options);
    const ownerId = randomUUID();
    try {
      const task = await database.transaction(ownerId, async ({ owners, tasks }) => {
        await owners.ensure();
        return tasks.create({
          key: randomUUID(),
          objective: "Signal fixture",
          sourceMessageIds: [],
        });
      });
      const controllers = [new AbortController(), new AbortController()] as const;
      const unrelated = new AbortController();
      const newer = new AbortController();
      first.watch(ownerId, task, controllers[0]);
      second.watch(ownerId, task, controllers[1]);
      first.watch(randomUUID(), task, unrelated);
      first.watch(ownerId, { ...task, revision: task.revision + 100 }, newer);
      await assert.rejects(
        database.transaction(ownerId, async ({ tasks }) => {
          await tasks.steer(task.id, task.revision, "Rolled back correction");
          throw new Error("rollback fixture");
        }),
        /rollback fixture/,
      );
      await Bun.sleep(50);
      assert.ok(controllers.every((controller) => !controller.signal.aborted));
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.steer(task.id, task.revision, "Committed correction"),
      );
      await until(() => controllers.every((controller) => controller.signal.aborted));
      assert.equal(unrelated.signal.aborted, false);
      assert.equal(newer.signal.aborted, false);
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'winston-task-signals'`;
      await until(() => disconnects === 2);
      assert.equal(unrelated.signal.aborted, true);
      await until(async () => {
        const rows = await sql<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'winston-task-signals'`;
        return rows[0]?.count === 2;
      });
      // Registration while reconnecting is fail-closed; wait for LISTEN to finish.
      await until(() => {
        const controller = new AbortController();
        const remove = first.watch(ownerId, task, controller);
        remove();
        return !controller.signal.aborted;
      });
      const current = await database.transaction(ownerId, ({ tasks }) => tasks.find(task.id));
      assert.ok(current);
      const recovered = new AbortController();
      first.watch(ownerId, current, recovered);
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.cancel(current.id, current.revision),
      );
      await until(() => recovered.signal.aborted);
    } finally {
      await first.stop();
      await second.stop();
      await database.close();
    }
  });
});

test("steering interrupts model generation before it can checkpoint an obsolete tool call", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const signals = await startTaskSignals({
      directConnectionString: connectionString,
      onDisconnect: () => {},
    });
    const ownerId = randomUUID();
    let entered = false;
    let interrupted = false;
    try {
      const task = await database.transaction(ownerId, async ({ owners, tasks }) => {
        await owners.ensure();
        return tasks.create({
          key: randomUUID(),
          objective: "Original task",
          sourceMessageIds: [],
        });
      });
      const step = createBackgroundStep({
        database,
        signals,
        generate: async ({ signal }) => {
          entered = true;
          assert.ok(signal);
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                interrupted = true;
                resolve();
              },
              { once: true },
            );
          });
          signal.throwIfAborted();
          throw new Error("Obsolete model generation continued.");
        },
      });
      const result = assert.rejects(
        step(
          { ownerId, referenceId: task.id, revision: task.revision },
          new AbortController().signal,
        ),
      );
      await until(() => entered);
      await database.transaction(ownerId, async ({ tasks }) => {
        const current = await tasks.find(task.id);
        assert.ok(current);
        await tasks.steer(current.id, current.revision, "Updated task");
      });
      await until(() => interrupted);
      await result;
      const current = await database.transaction(ownerId, ({ tasks }) => tasks.find(task.id));
      assert.equal(current?.state, "queued");
      assert.equal(current.objective, "Updated task");
    } finally {
      await signals.stop();
      await database.close();
    }
  });
});
