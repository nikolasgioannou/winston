import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, type OwnerTransaction } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("pause fences outstanding work, preserves edits and resumes without missed recurring runs", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const scope = <T>(work: (transaction: OwnerTransaction) => Promise<T>) =>
      database.transaction(ownerId, work);
    const timing = {
      kind: "recurring" as const,
      startAt: "2020-01-01T14:00:00.000Z",
      timezone: "America/New_York",
      rule: "FREQ=DAILY",
    };
    try {
      await scope(({ owners }) => owners.ensure());
      const schedule = await scope(({ schedules }) =>
        schedules.create({ key: "pause", objective: "Water plants", sourceMessageIds: [], timing }),
      );
      const first = await scope(({ schedules }) => schedules.claimDue());
      assert.ok(first);
      const paused = await scope(({ schedules }) => schedules.pause(schedule.id, 1));
      assert.equal(paused.state, "paused");
      assert.equal(paused.nextRunAt, null);
      assert.equal((await scope(({ tasks }) => tasks.find(first.task.id)))?.state, "canceled");
      assert.equal(await scope(({ schedules }) => schedules.claimDue()), undefined);
      await assert.rejects(
        scope(({ schedules }) => schedules.pause(schedule.id, 1)),
        /stale/,
      );
      const edited = await scope(({ schedules }) =>
        schedules.update(schedule.id, 2, {
          objective: "Water new plants",
          sourceMessageIds: [],
          timing,
        }),
      );
      assert.equal(edited.state, "paused");
      assert.equal(edited.nextRunAt, null);
      const before = Date.now();
      const resumed = await scope(({ schedules }) => schedules.resume(schedule.id, 3));
      assert.equal(resumed.state, "active");
      assert.ok(resumed.nextRunAt && new Date(resumed.nextRunAt).getTime() > before);
      assert.equal(resumed.timing.timezone, timing.timezone);
      assert.equal(await scope(({ schedules }) => schedules.claimDue()), undefined);
      await assert.rejects(
        scope(({ schedules }) => schedules.resume(schedule.id, 3)),
        /stale/,
      );
      const canceled = await scope(({ schedules }) => schedules.cancel(schedule.id, 4));
      await assert.rejects(
        scope(({ schedules }) => schedules.resume(schedule.id, canceled.revision)),
        /conflicts/,
      );
      await assert.rejects(
        scope(({ schedules }) =>
          schedules.update(schedule.id, canceled.revision, {
            objective: "Revive",
            sourceMessageIds: [],
            timing,
          }),
        ),
        /conflicts/,
      );
      const other = randomUUID();
      await database.transaction(other, ({ owners }) => owners.ensure());
      await assert.rejects(
        database.transaction(other, ({ schedules }) =>
          schedules.pause(schedule.id, canceled.revision),
        ),
        /unavailable/,
      );

      const once = await scope(({ schedules }) =>
        schedules.create({
          key: "once",
          objective: "Once",
          sourceMessageIds: [],
          timing: { kind: "once", startAt: timing.startAt, timezone: timing.timezone },
        }),
      );
      await scope(({ schedules }) => schedules.pause(once.id, 0));
      assert.equal(await scope(({ schedules }) => schedules.claimDue()), undefined);
      await scope(({ schedules }) => schedules.resume(once.id, 1));
      assert.equal((await scope(({ schedules }) => schedules.claimDue()))?.scheduleId, once.id);
      assert.equal(await scope(({ schedules }) => schedules.claimDue()), undefined);

      const finite = await scope(({ schedules }) =>
        schedules.create({
          key: "finite",
          objective: "Finite",
          sourceMessageIds: [],
          timing: { ...timing, rule: "FREQ=DAILY;COUNT=1" },
        }),
      );
      await scope(({ schedules }) => schedules.pause(finite.id, 0));
      assert.equal(
        (await scope(({ schedules }) => schedules.resume(finite.id, 1))).state,
        "completed",
      );
      assert.equal(await scope(({ schedules }) => schedules.claimDue()), undefined);
    } finally {
      await database.close();
    }
  });
});
