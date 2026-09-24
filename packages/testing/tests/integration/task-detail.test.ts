import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("task detail retains full current text and paged historical intent without authority", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    try {
      for (const id of [ownerId, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      let task = await database.transaction(ownerId, ({ tasks }) =>
        tasks.create({ key: "history", objective: "Original request", sourceMessageIds: [] }),
      );
      for (let index = 0; index < 42; index++) {
        task = await database.transaction(ownerId, ({ tasks }) =>
          tasks.steer(task.id, task.revision, `${String(index)} ${"x".repeat(3000)}`, []),
        );
      }
      const detail = await database.transaction(ownerId, ({ tasks }) => tasks.detail(task.id));
      assert.ok(detail);
      assert.equal(detail.objective, task.objective);
      assert.equal(detail.revision, 42);
      assert.deepEqual(Object.keys(detail).sort(), [
        "createdAt",
        "id",
        "objective",
        "result",
        "revision",
        "state",
        "updatedAt",
        "waiting",
      ]);
      const first = await database.transaction(ownerId, ({ tasks }) =>
        tasks.activityHistory(task.id),
      );
      assert.equal(first.items.length, 20);
      assert.equal(first.next, 23);
      assert.equal(first.items[0]?.objective.length, 2000);
      assert.equal(first.items[0].objectiveTruncated, true);
      await database.transaction(ownerId, ({ tasks }) => tasks.cancel(task.id, task.revision));
      const revisions = first.items.map((item) => item.revision);
      let before: number | null = first.next;
      while (before !== null) {
        const page = await database.transaction(ownerId, ({ tasks }) =>
          tasks.activityHistory(task.id, before ?? undefined),
        );
        revisions.push(...page.items.map((item) => item.revision));
        before = page.next;
        if (before === null) assert.equal(page.items.at(-1)?.objective, "Original request");
      }
      assert.deepEqual(
        revisions,
        Array.from({ length: 43 }, (_, index) => 42 - index),
      );
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.detail(task.id)))?.state,
        "canceled",
      );
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.activityHistory(task.id)))
          .items[0]?.state,
        "canceled",
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ tasks }) => tasks.activityHistory(task.id, 0)),
        { items: [], next: null },
      );
      assert.equal(await database.transaction(other, ({ tasks }) => tasks.detail(task.id)), null);
      assert.equal(
        await database.transaction(ownerId, ({ tasks }) => tasks.detail(randomUUID())),
        null,
      );
      assert.deepEqual(
        await database.transaction(other, ({ tasks }) => tasks.activityHistory(task.id)),
        {
          items: [],
          next: null,
        },
      );
      const queued = await database.transaction(ownerId, ({ tasks }) =>
        tasks.create({ key: "waiting", objective: "Read Gmail", sourceMessageIds: [] }),
      );
      const running = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(queued.id, queued.revision),
      );
      assert.ok(running);
      const waiting = await database.transaction(ownerId, ({ tasks }) =>
        tasks.finishStep(running.id, running.revision, running.generation, {
          state: "waiting",
          blocker: { kind: "connection", referenceId: randomUUID(), detail: "Connect Gmail" },
        }),
      );
      const publicWaiting = await database.transaction(ownerId, ({ tasks }) =>
        tasks.detail(waiting.id),
      );
      assert.deepEqual(publicWaiting?.waiting, { kind: "connection", detail: "Connect Gmail" });
      const blocker = waiting.blocker;
      assert.ok(blocker);
      const resumed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.resume(waiting.id, waiting.revision, blocker.referenceId),
      );
      const claimed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(resumed.id, resumed.revision),
      );
      assert.ok(claimed);
      const result = "Outcome ".repeat(1500);
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.finishStep(claimed.id, claimed.revision, claimed.generation, {
          state: "succeeded",
          result,
        }),
      );
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.detail(queued.id)))?.result,
        result,
      );
      const history = await database.transaction(ownerId, ({ tasks }) =>
        tasks.activityHistory(queued.id),
      );
      assert.equal(history.items[0]?.result?.length, 4000);
      assert.equal(history.items[0].resultTruncated, true);
      assert.deepEqual(
        history.items.find((entry) => entry.state === "waiting")?.waiting,
        publicWaiting.waiting,
      );
    } finally {
      await database.close();
    }
  });
});
