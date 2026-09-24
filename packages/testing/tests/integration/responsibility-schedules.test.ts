import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, type OwnerTransaction } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("responsibility checks lose scheduling and tool authority on pause, revision and end", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const run = <T>(work: (scope: OwnerTransaction) => Promise<T>) =>
      database.transaction(ownerId, work);
    try {
      await run(async ({ owners, workspaces }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Fixture");
        await workspaces.setState(workspaceId, 0, "active");
      });
      const allowed = {
        target: { kind: "workspace" as const, id: workspaceId, resource: null },
        operation: "workspace.command" as const,
      };
      const proposal = {
        key: "monitor",
        purpose: "Inspect the trip file",
        scope: [allowed],
        sourceMessageIds: [],
      };
      const responsibility = await run(({ responsibilities }) =>
        responsibilities.propose(proposal),
      );
      const input = {
        key: "check",
        objective: "Inspect trip",
        sourceMessageIds: [],
        timing: {
          kind: "recurring" as const,
          startAt: "2026-01-01T00:00:00.000Z",
          timezone: "UTC",
          rule: "FREQ=DAILY",
        },
        responsibility: { id: responsibility.id, agreementRevision: 0 },
      };
      await assert.rejects(
        run(({ schedules }) => schedules.create(input)),
        /conflict/,
      );
      await run(({ responsibilities }) => responsibilities.agree(responsibility.id, 0));
      await assert.rejects(
        run(({ schedules }) =>
          schedules.create({
            ...input,
            responsibility: { ...input.responsibility, agreementRevision: 1 },
          }),
        ),
        /conflict/,
      );
      const schedule = await run(({ schedules }) => schedules.create(input));
      const occurrence = await run(({ schedules }) => schedules.claimDue());
      assert.ok(occurrence);
      const worker = await run(({ tasks }) => tasks.claim(occurrence.task.id, 0));
      const task = { id: worker.id, revision: worker.revision, generation: worker.generation };
      const context = await run(({ tasks }) => tasks.context(task));
      assert.equal(context.scheduled?.responsibility?.id, responsibility.id);
      assert.deepEqual(context.scheduled.responsibility.scope, [allowed]);
      assert.equal(
        await run(({ responsibilityAccess }) => responsibilityAccess(task.id, allowed)),
        true,
      );
      const outside = { ...allowed, operation: "workspace.file.read" as const };
      assert.equal(
        await run(({ responsibilityAccess }) => responsibilityAccess(task.id, outside)),
        false,
      );
      const denied = await run(({ actions }) =>
        actions.prepare({ key: "outside", task, authorization: outside, arguments: {} }),
      );
      assert.equal(denied.state, "denied");
      const action = await run(({ actions }) =>
        actions.prepare({ key: "inside", task, authorization: allowed, arguments: {} }),
      );
      assert.equal(action.state, "approved");
      const capability = await run(({ capabilities }) =>
        capabilities.issue({
          kind: "workspace",
          subjectId: workspaceId,
          resourceId: workspaceId,
          resourceRevision: 1,
          taskId: task.id,
          revision: task.revision,
          generation: task.generation,
          operation: "gateway:control",
          credential: null,
        }),
      );
      const credential = {
        token: capability.token,
        kind: "workspace" as const,
        subjectId: workspaceId,
        resourceId: workspaceId,
        operation: "gateway:control" as const,
      };
      assert.equal(
        (
          await run(({ filePublications }) =>
            filePublications.authorize(credential, {
              version: 1,
              key: "outside-files",
              name: "trip.txt",
              mediaType: "text/plain",
              size: 1,
              sha256: "a".repeat(64),
            }),
          )
        ).status,
        "denied",
      );
      assert.equal(
        (
          await run(({ cli }) =>
            cli.schedule(credential, {
              version: 1,
              command: "schedules.cancel",
              id: schedule.id,
              revision: 1,
            }),
          )
        ).status,
        "denied",
      );
      await run(({ responsibilities }) =>
        responsibilities.transition(responsibility.id, 1, "paused"),
      );
      assert.equal((await run(({ schedules }) => schedules.find(schedule.id)))?.state, "paused");
      assert.equal((await run(({ tasks }) => tasks.find(task.id)))?.state, "canceled");
      assert.equal(await run(({ capabilities }) => capabilities.authenticate(credential)), null);
      assert.equal(await run(({ actions }) => actions.claim(action.id, action.hash, task)), null);
      await assert.rejects(
        run(({ schedules }) => schedules.resume(schedule.id, 2)),
        /conflict/,
      );
      assert.equal(await run(({ schedules }) => schedules.claimDue()), undefined);
      await run(({ responsibilities }) =>
        responsibilities.transition(responsibility.id, 2, "active"),
      );
      assert.equal((await run(({ schedules }) => schedules.find(schedule.id)))?.state, "paused");
      await run(({ schedules }) => schedules.resume(schedule.id, 2));
      await run(({ responsibilities }) =>
        responsibilities.revise(responsibility.id, 3, { ...proposal, purpose: "New scope" }),
      );
      assert.equal((await run(({ schedules }) => schedules.find(schedule.id)))?.state, "canceled");
      await assert.rejects(
        run(({ schedules }) => schedules.create({ ...input, key: "stale" })),
        /conflict/,
      );
      await run(({ responsibilities }) => responsibilities.agree(responsibility.id, 4));
      await assert.rejects(
        run(({ schedules }) => schedules.create({ ...input, key: "old-agreement" })),
        /conflict/,
      );
      const replacement = await run(({ schedules }) =>
        schedules.create({
          ...input,
          key: "replacement",
          responsibility: { id: responsibility.id, agreementRevision: 4 },
        }),
      );
      await run(({ responsibilities }) =>
        responsibilities.transition(responsibility.id, 5, "ended"),
      );
      assert.equal(
        (await run(({ schedules }) => schedules.find(replacement.id)))?.state,
        "canceled",
      );
      assert.equal(await run(({ schedules }) => schedules.claimDue()), undefined);
      const independent = await run(({ schedules }) =>
        schedules.create({
          key: "independent",
          objective: "Water plants",
          sourceMessageIds: [],
          timing: input.timing,
        }),
      );
      assert.equal(
        (await run(({ schedules }) => schedules.claimDue()))?.scheduleId,
        independent.id,
      );
      // Persisted invalid bindings fail closed even if an old writer left an active row.
      await sql`UPDATE winston.schedules SET next_run_at = clock_timestamp() - interval '1 day', document = jsonb_set(document, '{state}', '"active"') WHERE id = ${replacement.id}::uuid`;
      assert.equal(await run(({ schedules }) => schedules.claimDue()), undefined);
      assert.equal(
        (await run(({ schedules }) => schedules.find(replacement.id)))?.state,
        "canceled",
      );
    } finally {
      await database.close();
    }
  });
});
