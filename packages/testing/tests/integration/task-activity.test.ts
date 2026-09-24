import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { TaskActivityCursor } from "@winston/contracts/tasks";
import { withTestPostgres } from "../../src/postgres";

test("activity pages preserve precise creation order and isolate bounded current outcomes", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    try {
      for (const id of [ownerId, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      const original: { id: string; createdAt: string }[] = [];
      for (let index = 0; index < 43; index++) {
        const task = await database.transaction(ownerId, ({ tasks }) =>
          tasks.create({
            key: `fixture:${String(index)}`,
            objective: "x".repeat(2500),
            sourceMessageIds: [],
          }),
        );
        const createdAt = `2026-01-01T00:00:00.${String(Math.floor(index / 2) + 1).padStart(6, "0")}Z`;
        await sql`UPDATE winston.task_revisions SET created_at = ${createdAt}::timestamptz WHERE owner_id = ${ownerId}::uuid AND task_id = ${task.id}::uuid`;
        original.push({ id: task.id, createdAt });
      }
      original.sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
      const latest = original[0];
      assert.ok(latest);
      await sql`UPDATE winston.tasks SET document = document || jsonb_build_object('state', 'failed', 'result', ${"y".repeat(4500)}::text)
        WHERE owner_id = ${ownerId}::uuid AND id = ${latest.id}::uuid`;
      const first = await database.transaction(ownerId, ({ tasks }) => tasks.activity());
      assert.equal(first.items.length, 20);
      const item = first.items[0];
      assert.ok(item);
      assert.equal(item.createdAt, latest.createdAt);
      assert.equal(item.updatedAt, latest.createdAt);
      assert.equal(item.state, "failed");
      assert.equal(item.objective.length, 2000);
      assert.equal(item.objectiveTruncated, true);
      assert.equal(item.result?.length, 4000);
      assert.equal(item.resultTruncated, true);
      assert.deepEqual(Object.keys(item).sort(), [
        "createdAt",
        "id",
        "objective",
        "objectiveTruncated",
        "result",
        "resultTruncated",
        "revision",
        "state",
        "updatedAt",
        "waiting",
      ]);
      assert.ok(first.next);
      assert.deepEqual(first.next, original[19]);
      const newer = await database.transaction(ownerId, ({ tasks }) =>
        tasks.create({ key: "newer", objective: "New request", sourceMessageIds: [] }),
      );
      const all = first.items.map((entry) => entry.id);
      let before: TaskActivityCursor | undefined = first.next;
      while (before) {
        const page = await database.transaction(ownerId, ({ tasks }) => tasks.activity(before));
        all.push(...page.items.map((entry) => entry.id));
        before = page.next ?? undefined;
      }
      assert.deepEqual(
        all,
        original.map((entry) => entry.id),
      );
      const changed = await database.transaction(ownerId, ({ tasks }) => tasks.cancel(newer.id, 0));
      const refreshed = await database.transaction(ownerId, ({ tasks }) => tasks.activity());
      assert.equal(refreshed.items[0]?.id, changed.id);
      assert.equal(refreshed.items[0].state, "canceled");
      assert.equal(refreshed.items[0].revision, changed.revision);
      assert.deepEqual(await database.transaction(other, ({ tasks }) => tasks.activity()), {
        items: [],
        next: null,
      });
      assert.deepEqual(
        await database.transaction(other, ({ tasks }) => tasks.activity(first.next ?? undefined)),
        { items: [], next: null },
      );
      await sql`UPDATE winston.tasks SET document = document || jsonb_build_object('state', 'waiting', 'result', NULL,
        'blocker', jsonb_build_object('kind', 'device', 'referenceId', ${randomUUID()}::text, 'detail', 'Waiting for Mac'))
        WHERE owner_id = ${ownerId}::uuid AND id = ${newer.id}::uuid`;
      const waiting = (await database.transaction(ownerId, ({ tasks }) => tasks.activity()))
        .items[0];
      assert.deepEqual(waiting?.waiting, { kind: "device", detail: "Waiting for Mac" });
      assert.equal(waiting.result, null);
    } finally {
      await database.close();
    }
  });
});
