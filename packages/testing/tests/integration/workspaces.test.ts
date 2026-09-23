import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { WorkspaceOperation } from "@winston/contracts/workspace";
import { withTestPostgres } from "../../src/postgres";

test("workspace execution requires live owner, task and lifecycle authority", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    const workspaceId = randomUUID();
    const workerId = randomUUID();
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await database.transaction(other, ({ owners }) => owners.ensure());
      const task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: "workspace",
          objective: "Workspace fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const worker = {
        workerId,
        workspaceId,
        taskId: task.id,
        revision: task.revision,
        generation: task.generation,
      };
      const issue = () =>
        database.transaction(ownerId, ({ workspaces }) => workspaces.issueExecution(worker));
      const operation: WorkspaceOperation = {
        version: 1,
        identity: { ownerId, workspaceId },
        operationId: randomUUID(),
        taskId: task.id,
        revision: task.revision,
        generation: task.generation,
        kind: "workspace:inspect",
        inputHash: "a".repeat(64),
      };
      await assert.rejects(issue(), /unavailable/);
      const registered = await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.register(workspaceId, "Winston"),
      );
      assert.equal(registered.state, "paused");
      await assert.rejects(issue(), /unavailable/);
      assert.equal(
        await database.transaction(other, ({ workspaces }) => workspaces.find(workspaceId)),
        null,
      );
      await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.setState(workspaceId, 0, "active"),
      );
      await assert.rejects(
        database.transaction(other, ({ workspaces }) => workspaces.issueExecution(worker)),
        /unavailable/,
      );

      let capability = await issue();
      const credential = () => ({
        token: capability.token,
        kind: "worker" as const,
        subjectId: workerId,
        operation: "workspace:execute" as const,
        resourceId: workspaceId,
      });
      const authorize = (input = operation) =>
        database.transaction(ownerId, ({ workspaces }) =>
          workspaces.authorize(credential(), input),
        );
      assert.ok(await authorize());
      assert.equal(
        await authorize({ ...operation, identity: { ownerId: other, workspaceId } }),
        null,
      );
      assert.equal(
        await authorize({ ...operation, identity: { ownerId, workspaceId: randomUUID() } }),
        null,
      );
      assert.equal(await authorize({ ...operation, generation: task.generation + 1 }), null);
      assert.equal(await authorize({ ...operation, revision: task.revision + 1 }), null);
      assert.equal(await authorize({ ...operation, taskId: randomUUID() }), null);
      assert.equal(
        await database.transaction(ownerId, ({ workspaces }) =>
          workspaces.authorize({ ...credential(), kind: "workspace" }, operation),
        ),
        null,
      );
      assert.equal(
        await database.transaction(ownerId, ({ workspaces }) =>
          workspaces.authorize({ ...credential(), subjectId: randomUUID() }, operation),
        ),
        null,
      );
      assert.equal(
        await database.transaction(other, ({ workspaces }) =>
          workspaces.authorize(credential(), operation),
        ),
        null,
      );

      assert.equal(
        await database.transaction(ownerId, ({ workspaces }) =>
          workspaces.setState(workspaceId, 0, "paused"),
        ),
        null,
      );
      await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.setState(workspaceId, 1, "paused"),
      );
      assert.equal(await authorize(), null);
      await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.setState(workspaceId, 2, "active"),
      );
      assert.equal(await authorize(), null, "reactivation cannot revive old capabilities");
      capability = await issue();
      assert.ok(await authorize());

      const bound = capability;
      capability = await database.transaction(ownerId, ({ capabilities }) =>
        capabilities.issue({
          kind: "worker",
          subjectId: workerId,
          taskId: task.id,
          revision: task.revision,
          generation: task.generation,
          operation: "workspace:execute",
          resourceId: workspaceId,
          credential: null,
        }),
      );
      assert.equal(
        await authorize(),
        null,
        "capabilities without a workspace lifecycle revision are insufficient",
      );
      capability = bound;

      await database.transaction(ownerId, ({ capabilities }) => capabilities.revoke(capability.id));
      assert.equal(await authorize(), null);
      capability = await issue();
      await sql`UPDATE winston.service_capabilities SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${capability.id}::uuid`;
      assert.equal(await authorize(), null);
      capability = await issue();
      await database.transaction(ownerId, ({ tasks }) => tasks.cancel(task.id, task.revision));
      assert.equal(await authorize(), null);
      await assert.rejects(issue(), /no longer current/);

      await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.setState(workspaceId, 3, "retired"),
      );
      assert.equal(
        await database.transaction(ownerId, ({ workspaces }) =>
          workspaces.setState(workspaceId, 4, "active"),
        ),
        null,
      );
      assert.equal(
        (
          await database.transaction(ownerId, ({ workspaces }) =>
            workspaces.register(workspaceId, "Winston"),
          )
        ).state,
        "retired",
      );
      await assert.rejects(
        database.transaction(ownerId, ({ workspaces }) =>
          workspaces.register(workspaceId, "Replacement"),
        ),
        /conflicts/,
      );
    } finally {
      await database.close();
    }
  });
});
