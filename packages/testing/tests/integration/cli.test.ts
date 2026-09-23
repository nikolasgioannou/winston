import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { CliRequest } from "@winston/contracts/cli";
import { withTestPostgres } from "../../src/postgres";

test("CLI discovery rechecks task, workspace and credential state and isolates resources", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const owner = randomUUID();
    const other = randomUUID();
    const workspaceId = randomUUID();
    try {
      for (const id of [owner, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      await database.transaction(owner, async ({ workspaces }) => {
        await workspaces.register(workspaceId, "CLI fixture");
        await workspaces.setState(workspaceId, 0, "active");
      });
      const task = await database.transaction(owner, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Discovery fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const scope = {
        kind: "workspace",
        subjectId: workspaceId,
        resourceId: workspaceId,
        resourceRevision: 1,
        taskId: task.id,
        revision: task.revision,
        generation: task.generation,
        operation: "gateway:read",
        credential: null,
      } as const;
      const issue = () =>
        database.transaction(owner, ({ capabilities }) => capabilities.issue(scope));
      const grant = await issue();
      const credential = {
        token: grant.token,
        kind: scope.kind,
        subjectId: workspaceId,
        resourceId: workspaceId,
        operation: scope.operation,
      };
      const execute = (input: CliRequest, token = grant.token, ownerId = owner) =>
        database.transaction(ownerId, ({ cli }) => cli.execute({ ...credential, token }, input));
      assert.equal((await execute({ version: 1, command: "accounts.list" })).status, "ok");
      assert.equal(
        (await execute({ version: 1, command: "devices.list" }, grant.token, other)).status,
        "denied",
      );
      assert.equal(
        (await execute({ version: 1, command: "devices.inspect", id: randomUUID() })).status,
        "denied",
      );
      assert.equal(
        (await execute({ version: 1, command: "operations.cancel", id: randomUUID() })).status,
        "denied",
      );
      const prepare = (taskId: string) =>
        database.transaction(owner, ({ actions }) =>
          actions.prepare({
            key: randomUUID(),
            task: { id: taskId, revision: task.revision, generation: task.generation },
            authorization: {
              target: { kind: "workspace", id: workspaceId, resource: null },
              operation: "workspace.command",
            },
            arguments: {},
          }),
        );
      const action = await prepare(task.id);
      assert.equal(
        (await execute({ version: 1, command: "operations.inspect", id: action.id })).status,
        "ok",
      );
      const another = await database.transaction(owner, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Other task",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const unrelated = await prepare(another.id);
      assert.equal(
        (await execute({ version: 1, command: "operations.inspect", id: unrelated.id })).status,
        "denied",
      );
      assert.equal(
        await database.authenticateService({ ...credential, resourceId: randomUUID() }),
        null,
      );
      const expired = await issue();
      await sql`UPDATE winston.service_capabilities SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${expired.id}::uuid`;
      assert.equal(
        (await execute({ version: 1, command: "devices.list" }, expired.token)).status,
        "denied",
      );
      const revoked = await issue();
      await database.transaction(owner, ({ capabilities }) => capabilities.revoke(revoked.id));
      assert.equal(
        (await execute({ version: 1, command: "devices.list" }, revoked.token)).status,
        "denied",
      );
      await database.transaction(owner, ({ workspaces }) =>
        workspaces.setState(workspaceId, 1, "paused"),
      );
      assert.equal((await execute({ version: 1, command: "devices.list" })).status, "denied");
      await database.transaction(owner, ({ workspaces }) =>
        workspaces.setState(workspaceId, 2, "active"),
      );
      const fresh = await database.transaction(owner, ({ capabilities }) =>
        capabilities.issue({ ...scope, resourceRevision: 3 }),
      );
      assert.equal(
        (await execute({ version: 1, command: "devices.list" }, fresh.token)).status,
        "ok",
      );
      await database.transaction(owner, ({ tasks }) =>
        tasks.steer(task.id, task.revision, "New intent"),
      );
      assert.equal(
        (await execute({ version: 1, command: "devices.list" }, fresh.token)).status,
        "denied",
      );
    } finally {
      await database.close();
    }
  });
});
