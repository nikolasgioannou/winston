import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { ScheduleRunCursor } from "@winston/contracts/schedules";
import { withTestPostgres } from "../../src/postgres";

test("schedule run history isolates owners and pages retained outcomes across edits", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    try {
      for (const id of [ownerId, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      const schedule = await database.transaction(ownerId, ({ schedules }) =>
        schedules.create({
          key: "history",
          objective: "Fixture reminder",
          sourceMessageIds: [],
          timing: { kind: "once", startAt: "2030-01-01T00:00:00.000Z", timezone: "UTC" },
        }),
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ schedules }) => schedules.runs(schedule.id)),
        { items: [], next: null },
      );
      const taskIds: string[] = [];
      for (let index = 0; index < 43; index++) {
        const task = await database.transaction(ownerId, ({ tasks }) =>
          tasks.create({
            key: `run:${String(index)}`,
            objective: "Private task objective",
            sourceMessageIds: [],
          }),
        );
        taskIds.push(task.id);
        const revision = Math.floor(index / 2);
        const dueAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        await sql`INSERT INTO winston.schedule_occurrences (owner_id, schedule_id, revision, due_at, task_id)
          VALUES (${ownerId}::uuid, ${schedule.id}::uuid, ${revision}, ${dueAt}::timestamptz, ${task.id}::uuid)`;
      }
      const latestId = taskIds.at(-1);
      assert.ok(latestId);
      const result = "x".repeat(4500);
      await sql`UPDATE winston.tasks SET document = document || jsonb_build_object('state', 'failed', 'result', ${result}::text)
        WHERE owner_id = ${ownerId}::uuid AND id = ${latestId}::uuid`;
      const all: string[] = [];
      let before: ScheduleRunCursor | undefined;
      do {
        const page = await database.transaction(ownerId, ({ schedules }) =>
          schedules.runs(schedule.id, before),
        );
        assert.ok(page.items.length <= 20);
        if (!before) {
          const latest = page.items[0];
          assert.equal(latest?.state, "failed");
          assert.equal(latest.result?.length, 4000);
          assert.equal(latest.truncated, true);
          assert.equal(latest.waiting, null);
          assert.deepEqual(Object.keys(latest).sort(), [
            "dueAt",
            "result",
            "scheduleRevision",
            "state",
            "taskId",
            "truncated",
            "waiting",
          ]);
        }
        all.push(...page.items.map((item) => item.taskId));
        before = page.next ?? undefined;
      } while (before);
      assert.deepEqual(all, [...taskIds].reverse());
      await assert.rejects(
        database.transaction(other, ({ schedules }) => schedules.runs(schedule.id)),
        /unavailable/,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ schedules }) => schedules.runs(randomUUID())),
        /unavailable/,
      );

      // A run's state is read afresh, rather than copied from the schedule's state.
      const detail = "Waiting for the selected computer";
      const referenceId = randomUUID();
      await sql`UPDATE winston.tasks SET document = document || jsonb_build_object('state', 'waiting', 'result', NULL,
        'blocker', jsonb_build_object('kind', 'device', 'detail', ${detail}::text, 'referenceId', ${referenceId}::text))
        WHERE owner_id = ${ownerId}::uuid AND id = ${latestId}::uuid`;
      const waiting = (
        await database.transaction(ownerId, ({ schedules }) => schedules.runs(schedule.id))
      ).items[0];
      assert.deepEqual(waiting?.waiting, { kind: "device", detail });
      assert.equal(waiting.result, null);
      assert.equal(waiting.truncated, false);
      const edited = await database.transaction(ownerId, ({ schedules }) =>
        schedules.update(schedule.id, 0, {
          objective: "Updated instruction",
          sourceMessageIds: [],
          timing: schedule.timing,
        }),
      );
      await database.transaction(ownerId, ({ schedules }) =>
        schedules.cancel(schedule.id, edited.revision),
      );
      const canceled = (
        await database.transaction(ownerId, ({ schedules }) => schedules.runs(schedule.id))
      ).items[0];
      assert.equal(canceled?.state, "canceled");
      assert.equal(canceled.waiting, null);
      assert.equal(canceled.taskId, latestId);
      const unrelated = await database.transaction(ownerId, ({ schedules }) =>
        schedules.create({
          key: "unrelated",
          objective: "Separate schedule",
          sourceMessageIds: [],
          timing: schedule.timing,
        }),
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ schedules }) => schedules.runs(unrelated.id)),
        { items: [], next: null },
      );
    } finally {
      await database.close();
    }
  });
});
