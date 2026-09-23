import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("blocked execution retries persist, back off and wake only once without changing intent", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    let database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const referenceId = randomUUID();
    try {
      const queued = await database.transaction(ownerId, async ({ owners, tasks }) => {
        await owners.ensure();
        return tasks.create({
          key: randomUUID(),
          objective: "Retry fixture",
          sourceMessageIds: [],
        });
      });
      let current = queued;
      for (let attempt = 1; attempt <= 9; attempt += 1) {
        current = await database.transaction(ownerId, ({ tasks }) =>
          tasks.claim(current.id, current.revision),
        );
        current = await database.transaction(ownerId, ({ tasks }) =>
          tasks.finishStep(current.id, current.revision, current.generation, {
            state: "waiting",
            blocker: { kind: "execution", referenceId, detail: "Observe the original operation" },
          }),
        );
        const rows = await sql<{ delay: number; attempt: number; intent: number }[]>`
          SELECT extract(epoch FROM retry_at - clock_timestamp())::float8 AS delay,
            retry_attempt AS attempt, intent_revision AS intent FROM winston.tasks
          WHERE owner_id = ${ownerId}::uuid AND id = ${current.id}::uuid`;
        const row = rows[0];
        assert.ok(row);
        const expected = Math.min(3600, 30 * 2 ** (attempt - 1));
        assert.ok(row.delay > expected - 5 && row.delay <= expected);
        assert.equal(row.attempt, Math.min(attempt, 8));
        assert.equal(row.intent, 0);
        assert.deepEqual(await database.transaction(ownerId, ({ tasks }) => tasks.wakeDue()), []);
        await database.close();
        database = createDatabase({ connectionString, onConnectionError: () => {} });
        await sql`UPDATE winston.tasks SET retry_at = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
        const wakes = await Promise.all([
          database.transaction(ownerId, ({ tasks }) => tasks.wakeDue()),
          database.transaction(ownerId, ({ tasks }) => tasks.wakeDue()),
        ]);
        assert.equal(wakes.flat().length, 1);
        const next = wakes.flat()[0];
        assert.ok(next);
        current = next;
      }
      current = await database.transaction(ownerId, ({ tasks }) =>
        tasks.steer(current.id, current.revision, "New intent"),
      );
      current = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(current.id, current.revision),
      );
      current = await database.transaction(ownerId, ({ tasks }) =>
        tasks.finishStep(current.id, current.revision, current.generation, {
          state: "waiting",
          blocker: { kind: "workspace", referenceId, detail: "Workspace offline" },
        }),
      );
      const reset = await sql<
        { attempt: number; intent: number }[]
      >`SELECT retry_attempt AS attempt, intent_revision AS intent FROM winston.tasks WHERE owner_id = ${ownerId}::uuid`;
      assert.deepEqual(reset[0], { attempt: 1, intent: 1 });
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.cancel(current.id, current.revision),
      );
      await sql`UPDATE winston.tasks SET retry_at = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      assert.deepEqual(await database.transaction(ownerId, ({ tasks }) => tasks.wakeDue()), []);
      const approval = await database.transaction(ownerId, async ({ tasks }) => {
        const task = await tasks.create({
          key: randomUUID(),
          objective: "Approval wait",
          sourceMessageIds: [],
        });
        const running = await tasks.claim(task.id, task.revision);
        return tasks.finishStep(running.id, running.revision, running.generation, {
          state: "waiting",
          blocker: { kind: "approval", referenceId, detail: "Needs approval" },
        });
      });
      await sql`UPDATE winston.tasks SET retry_at = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid AND id = ${approval.id}::uuid`;
      assert.deepEqual(await database.transaction(ownerId, ({ tasks }) => tasks.wakeDue()), []);
      assert.deepEqual(
        await database.transaction(randomUUID(), ({ tasks }) => tasks.wakeDue()),
        [],
      );
    } finally {
      await database.close();
    }
  });
});
