import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, type OwnerTransaction } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("new agreement revisions create separate scoped setup without replaying old tasks or schedules", async () => {
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
      const input = {
        key: "watch",
        purpose: "Watch the workspace",
        scope: [
          {
            target: { kind: "workspace" as const, id: workspaceId, resource: null },
            operation: "workspace.command" as const,
          },
        ],
        sourceMessageIds: [],
      };
      const proposal = await run(({ responsibilities }) => responsibilities.propose(input));
      const setup = async () => {
        const rows = await sql<
          { taskId: string }[]
        >`SELECT task_id AS "taskId" FROM winston.responsibility_requests WHERE owner_id = ${ownerId}::uuid AND responsibility_id = ${proposal.id}::uuid`;
        const id = rows[0]?.taskId;
        assert.ok(id);
        const task = await run(({ tasks }) => tasks.find(id));
        assert.ok(task);
        return task;
      };
      await run(({ responsibilities }) => responsibilities.agree(proposal.id, 0));
      const first = await setup();
      assert.equal(first.state, "queued");
      await assert.rejects(
        run(({ responsibilities }) => responsibilities.agree(proposal.id, 0)),
        /conflict/,
      );
      assert.deepEqual(await setup(), first);
      const worker = await run(({ tasks }) => tasks.claim(first.id, first.revision));
      const context = await run(({ tasks }) =>
        tasks.context({ id: worker.id, revision: worker.revision, generation: worker.generation }),
      );
      assert.equal(context.responsibilitySetup?.id, proposal.id);
      assert.equal(context.responsibilitySetup.agreement?.proposalRevision, 0);
      const schedule = await run(({ schedules }) =>
        schedules.create({
          key: "original",
          objective: input.purpose,
          sourceMessageIds: [],
          timing: { kind: "once", startAt: "2030-01-01T12:00:00.000Z", timezone: "UTC" },
          responsibility: { id: proposal.id, agreementRevision: 0 },
        }),
      );
      const completed = await run(({ tasks }) =>
        tasks.finishStep(worker.id, worker.revision, worker.generation, {
          state: "succeeded",
          result: "Configured",
        }),
      );

      await run(({ responsibilities }) =>
        responsibilities.revise(proposal.id, 1, { ...input, purpose: "Watch only release files" }),
      );
      assert.equal((await run(({ schedules }) => schedules.find(schedule.id)))?.state, "canceled");
      assert.equal((await setup()).id, first.id, "An edit alone cannot start work");
      await run(({ responsibilities }) => responsibilities.agree(proposal.id, 2));
      const replacement = await setup();
      assert.notEqual(replacement.id, first.id);
      assert.equal(replacement.state, "queued");
      assert.match(replacement.objective, /Watch only release files/);
      assert.deepEqual(await run(({ tasks }) => tasks.find(first.id)), completed);
      const replacementWorker = await run(({ tasks }) =>
        tasks.claim(replacement.id, replacement.revision),
      );
      const replacementContext = await run(({ tasks }) =>
        tasks.context({
          id: replacementWorker.id,
          revision: replacementWorker.revision,
          generation: replacementWorker.generation,
        }),
      );
      assert.equal(replacementContext.responsibilitySetup?.agreement?.proposalRevision, 2);
      assert.equal(
        await run(({ responsibilityAccess }) =>
          responsibilityAccess(replacement.id, {
            target: { kind: "workspace", id: workspaceId, resource: null },
            operation: "workspace.file.write",
          }),
        ),
        false,
      );
      await run(({ responsibilities }) => responsibilities.transition(proposal.id, 3, "paused"));
      assert.equal((await setup()).state, "canceled");
      await run(({ responsibilities }) => responsibilities.transition(proposal.id, 4, "active"));
      assert.equal((await setup()).state, "canceled", "Resume does not replay canceled setup");
      assert.equal((await run(({ schedules }) => schedules.find(schedule.id)))?.state, "canceled");

      await run(({ responsibilities }) =>
        responsibilities.revise(proposal.id, 5, { ...input, purpose: "Watch release notes" }),
      );
      await run(({ responsibilities }) => responsibilities.agree(proposal.id, 6));
      const third = await setup();
      const steered = await run(({ tasks }) =>
        tasks.steer(third.id, third.revision, "Unrelated task"),
      );
      await run(({ responsibilities }) =>
        responsibilities.revise(proposal.id, 7, { ...input, purpose: "Watch deployment results" }),
      );
      await run(({ responsibilities }) => responsibilities.agree(proposal.id, 8));
      assert.notEqual((await setup()).id, third.id);
      assert.deepEqual(await run(({ tasks }) => tasks.find(third.id)), steered);
      await run(({ responsibilities }) => responsibilities.transition(proposal.id, 9, "ended"));
      assert.equal((await setup()).state, "canceled");
      assert.deepEqual(await run(({ tasks }) => tasks.find(third.id)), steered);
      const count = await sql<
        { count: number }[]
      >`SELECT count(*)::integer AS count FROM winston.tasks WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(count[0]?.count, 4);
    } finally {
      await database.close();
    }
  });
});
