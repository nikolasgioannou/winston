import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("task revisions fence workers, retain blockers after restart, and keep cancellation terminal", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    let database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const request = { key: "request-1", objective: "Find a report", sourceMessageIds: [] };

    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      const queued = await database.transaction(ownerId, ({ tasks }) => tasks.create(request));
      assert.deepEqual(
        await database.transaction(ownerId, ({ tasks }) => tasks.create(request)),
        queued,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) =>
          tasks.create({ ...request, objective: "Different" }),
        ),
        /conflicts/,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) =>
          tasks.create({ ...request, key: "bad-source", sourceMessageIds: [randomUUID()] }),
        ),
        /unavailable/,
      );

      const claims = await Promise.allSettled([
        database.transaction(ownerId, ({ tasks }) => tasks.claim(queued.id, queued.revision)),
        database.transaction(ownerId, ({ tasks }) => tasks.claim(queued.id, queued.revision)),
      ]);
      assert.equal(claims.filter(({ status }) => status === "fulfilled").length, 1);
      const running = await database.transaction(ownerId, ({ tasks }) => tasks.find(queued.id));
      assert.ok(running);
      assert.equal(running.state, "running");
      assert.equal(
        await database.transaction(ownerId, ({ tasks }) =>
          tasks.heartbeat(running.id, running.revision, running.generation),
        ),
        true,
      );

      await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(
        await database.transaction(ownerId, ({ tasks }) =>
          tasks.heartbeat(running.id, running.revision, running.generation),
        ),
        false,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) =>
          tasks.finishStep(running.id, running.revision, running.generation, {
            state: "succeeded",
            result: "stale",
          }),
        ),
        /expired/,
      );
      const reclaimed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(running.id, running.revision),
      );
      assert.ok(reclaimed.generation > running.generation);
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) =>
          tasks.finishStep(running.id, running.revision, running.generation, {
            state: "succeeded",
            result: "stale",
          }),
        ),
        /stale/,
      );

      const blocker = {
        kind: "connection" as const,
        referenceId: randomUUID(),
        detail: "Connect Gmail",
      };
      const waiting = await database.transaction(ownerId, ({ tasks }) =>
        tasks.finishStep(reclaimed.id, reclaimed.revision, reclaimed.generation, {
          state: "waiting",
          blocker,
        }),
      );
      await database.close();
      database = createDatabase({ connectionString, onConnectionError: () => {} });
      assert.deepEqual(
        await database.transaction(ownerId, ({ tasks }) => tasks.find(waiting.id)),
        waiting,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) => tasks.claim(waiting.id, waiting.revision)),
        /current state/,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) =>
          tasks.resume(waiting.id, waiting.revision, randomUUID()),
        ),
        /unrelated/,
      );
      const resumed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.resume(waiting.id, waiting.revision, blocker.referenceId),
      );
      const next = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(resumed.id, resumed.revision),
      );
      const steered = await database.transaction(ownerId, ({ tasks }) =>
        tasks.steer(next.id, next.revision, "Find the corrected report"),
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) =>
          tasks.finishStep(next.id, next.revision, next.generation, {
            state: "succeeded",
            result: "wrong report",
          }),
        ),
        /stale/,
      );
      assert.equal(steered.objective, "Find the corrected report");
      const canceled = await database.transaction(ownerId, ({ tasks }) =>
        tasks.cancel(steered.id, steered.revision),
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) =>
          tasks.steer(canceled.id, canceled.revision, "Restart"),
        ),
        /Terminal/,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) => tasks.claim(canceled.id, canceled.revision)),
        /current state/,
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ tasks }) =>
          tasks.cancel(canceled.id, canceled.revision),
        ),
        canceled,
      );
      assert.deepEqual(await database.transaction(ownerId, ({ tasks }) => tasks.listActive()), []);
      const history = await database.transaction(ownerId, ({ tasks }) =>
        tasks.history(canceled.id),
      );
      assert.equal(history.length, canceled.revision + 1);
      assert.equal(history[0]?.objective, "Find a report");
      const count = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'task.changed'`;
      assert.equal(count[0]?.count, history.length);

      const otherOwner = randomUUID();
      await database.transaction(otherOwner, ({ owners }) => owners.ensure());
      assert.equal(
        await database.transaction(otherOwner, ({ tasks }) => tasks.find(canceled.id)),
        undefined,
      );
      assert.deepEqual(
        await database.transaction(otherOwner, ({ tasks }) => tasks.history(canceled.id)),
        [],
      );
      for (const state of ["succeeded", "failed"] as const) {
        const created = await database.transaction(ownerId, ({ tasks }) =>
          tasks.create({ ...request, key: state }),
        );
        const claimed = await database.transaction(ownerId, ({ tasks }) =>
          tasks.claim(created.id, created.revision),
        );
        const finished = await database.transaction(ownerId, ({ tasks }) =>
          tasks.finishStep(claimed.id, claimed.revision, claimed.generation, {
            state,
            result: "Verified fixture outcome",
          }),
        );
        assert.equal(finished.state, state);
        await assert.rejects(
          database.transaction(ownerId, ({ tasks }) =>
            tasks.cancel(finished.id, finished.revision),
          ),
          /Terminal/,
        );
      }
      await assert.rejects(
        database.transaction(otherOwner, ({ tasks }) =>
          tasks.cancel(canceled.id, canceled.revision),
        ),
        /unavailable/,
      );
    } finally {
      await database.close();
    }
  });
});
