import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, type OwnerTransaction } from "@winston/adapters/database";
import type { ScheduleRequest } from "@winston/contracts/schedules";
import { withTestPostgres } from "../../src/postgres";

test("schedule claims are durable, owner-scoped and coalesce missed runs without overlap", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const stranger = randomUUID();
    const scope = <Result>(work: (scope: OwnerTransaction) => Promise<Result>) =>
      database.transaction(ownerId, work);
    const request: ScheduleRequest = {
      key: "reminder",
      objective: "Remind me to water the plants.",
      sourceMessageIds: [],
      timing: {
        kind: "recurring",
        timezone: "America/New_York",
        startAt: "2026-01-01T14:00:00.000Z",
        rule: "FREQ=DAILY",
      },
    };
    try {
      await scope(({ owners }) => owners.ensure());
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      const created = await scope(({ schedules }) => schedules.create(request));
      assert.equal((await scope(({ schedules }) => schedules.create(request))).id, created.id);
      await assert.rejects(
        scope(({ schedules }) => schedules.create({ ...request, objective: "Different" })),
        /conflicts/,
      );
      assert.equal(
        await database.transaction(stranger, ({ schedules }) => schedules.find(created.id)),
        undefined,
      );
      await assert.rejects(
        database.transaction(stranger, ({ schedules }) => schedules.cancel(created.id, 0)),
        /unavailable/,
      );
      await scope(({ owners }) => owners.updateTimezone("Asia/Tokyo", 0));
      assert.equal(
        (await scope(({ schedules }) => schedules.find(created.id)))?.timing.timezone,
        "America/New_York",
      );

      const claims = await Promise.all([
        scope(({ schedules }) => schedules.claimDue()),
        scope(({ schedules }) => schedules.claimDue()),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const occurrence = claims.find(Boolean);
      assert.ok(occurrence);
      assert.equal(occurrence.dueAt, request.timing.startAt);
      const advanced = await scope(({ schedules }) => schedules.find(created.id));
      assert.ok(advanced?.nextRunAt);
      assert.ok(new Date(advanced.nextRunAt).getTime() > Date.now());
      assert.equal(advanced.revision, 1);
      // A restart observes the persisted next run and does not duplicate the occurrence.
      const restarted = createDatabase({ connectionString, onConnectionError: () => {} });
      try {
        assert.equal(
          await restarted.transaction(ownerId, ({ schedules }) => schedules.claimDue()),
          undefined,
        );
      } finally {
        await restarted.close();
      }
      await assert.rejects(
        scope(({ schedules }) => schedules.cancel(created.id, 0)),
        /stale/,
      );
      const instructionOnly = await scope(({ schedules }) =>
        schedules.update(created.id, 1, {
          objective: "Changed instruction",
          sourceMessageIds: [],
          timing: request.timing,
        }),
      );
      assert.equal(instructionOnly.nextRunAt, advanced.nextRunAt);
      assert.equal(await scope(({ schedules }) => schedules.claimDue()), undefined);
      const changed = await scope(({ schedules }) =>
        schedules.update(created.id, 2, {
          objective: "Updated reminder",
          sourceMessageIds: [],
          timing: { ...request.timing, startAt: "2026-01-02T14:00:00.000Z" },
        }),
      );
      assert.equal((await scope(({ tasks }) => tasks.find(occurrence.task.id)))?.state, "canceled");
      const replacement = await scope(({ schedules }) => schedules.claimDue());
      assert.ok(replacement);
      assert.equal(replacement.task.objective, "Updated reminder");
      await sql`UPDATE winston.schedules SET next_run_at = clock_timestamp() - interval '1 second' WHERE id = ${created.id}::uuid`;
      assert.equal(await scope(({ schedules }) => schedules.claimDue()), undefined);
      const canceled = await scope(({ schedules }) =>
        schedules.cancel(created.id, changed.revision + 1),
      );
      assert.equal(canceled.state, "canceled");
      assert.equal(
        (await scope(({ tasks }) => tasks.find(replacement.task.id)))?.state,
        "canceled",
      );
      assert.equal(await scope(({ schedules }) => schedules.claimDue()), undefined);

      const once = await scope(({ schedules }) =>
        schedules.create({
          ...request,
          key: "once",
          timing: {
            kind: "once",
            startAt: request.timing.startAt,
            timezone: request.timing.timezone,
          },
        }),
      );
      await assert.rejects(
        scope(async ({ schedules }) => {
          assert.ok(await schedules.claimDue());
          throw new Error("Rollback probe");
        }),
        /Rollback probe/,
      );
      assert.equal((await scope(({ schedules }) => schedules.find(once.id)))?.revision, 0);
      const final = await scope(({ schedules }) => schedules.claimDue());
      assert.equal(final?.scheduleId, once.id);
      assert.equal((await scope(({ schedules }) => schedules.find(once.id)))?.state, "completed");
      const editedCompleted = await scope(({ schedules }) =>
        schedules.update(once.id, 1, {
          objective: "Reworded reminder",
          sourceMessageIds: [],
          timing: once.timing,
        }),
      );
      assert.equal(editedCompleted.state, "completed");
      assert.equal(editedCompleted.nextRunAt, null);
      assert.equal(await scope(({ schedules }) => schedules.claimDue()), undefined);
      const receipts = await sql<
        { count: number }[]
      >`SELECT count(*)::integer AS count FROM winston.schedule_occurrences WHERE schedule_id = ${once.id}::uuid`;
      assert.equal(receipts[0]?.count, 1);
      await assert.rejects(
        scope(({ schedules }) =>
          schedules.create({
            ...request,
            key: "foreign-source",
            sourceMessageIds: [randomUUID()],
          }),
        ),
        /source messages/,
      );
    } finally {
      await database.close();
    }
  });
});
