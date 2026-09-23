import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { commandInputSchema } from "@winston/contracts/commands";
import { canonicalJson } from "@winston/contracts/json";
import type { WorkspaceCommand } from "@winston/contracts/workspace-commands";
import { withTestPostgres } from "../../src/postgres";

test("commands require exact dispatch proof while recovery stays scoped after cancellation", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    const workspaceId = randomUUID();
    const subjectId = randomUUID();
    try {
      await database.transaction(other, ({ owners }) => owners.ensure());
      const task = await database.transaction(ownerId, async ({ owners, workspaces, tasks }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Command fixture");
        await workspaces.setState(workspaceId, 0, "active");
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Command fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const input = commandInputSchema.parse({
        argv: ["echo", "fixture"],
        cwd: "/home/winston",
        env: {},
        timeoutMs: 1000,
      });
      const version = { id: task.id, revision: task.revision, generation: task.generation };
      const action = await database.transaction(ownerId, ({ actions }) =>
        actions.prepare({
          key: randomUUID(),
          task: version,
          authorization: {
            target: { kind: "workspace", id: workspaceId, resource: null },
            operation: "workspace.command",
          },
          arguments: input,
        }),
      );
      const claim = await database.transaction(ownerId, ({ actions }) =>
        actions.claim(action.id, action.hash, version),
      );
      assert.ok(claim?.claimed);
      const execution = await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.issueExecution({
          workerId: subjectId,
          workspaceId,
          taskId: task.id,
          revision: task.revision,
          generation: task.generation,
        }),
      );
      const request = {
        token: execution.token,
        kind: "worker" as const,
        subjectId,
        resourceId: workspaceId,
        operation: "workspace:execute" as const,
      };
      const command: WorkspaceCommand = {
        operation: {
          version: 1,
          identity: { ownerId, workspaceId },
          operationId: action.operationId,
          taskId: task.id,
          revision: task.revision,
          generation: task.generation,
          kind: "command:execute",
          inputHash: createHash("sha256").update(canonicalJson(input)).digest("hex"),
        },
        input,
        dispatch: { id: action.id, token: claim.token },
      };
      const authorize = (value = command) =>
        database.transaction(ownerId, ({ workspaces }) =>
          workspaces.authorizeCommand(request, value),
        );
      assert.ok(await authorize());
      assert.equal(
        await database.transaction(ownerId, ({ workspaces }) =>
          workspaces.authorize(request, command.operation),
        ),
        null,
      );
      assert.equal(
        await authorize({ ...command, input: { ...input, argv: ["echo", "changed"] } }),
        null,
      );
      assert.equal(
        await authorize({
          ...command,
          dispatch: { ...command.dispatch, token: `wda_${"x".repeat(43)}` },
        }),
        null,
      );
      assert.equal(
        await authorize({ ...command, dispatch: { ...command.dispatch, id: randomUUID() } }),
        null,
      );
      assert.equal(
        await authorize({
          ...command,
          operation: { ...command.operation, inputHash: "a".repeat(64) },
        }),
        null,
      );
      assert.equal(
        await database.transaction(other, ({ workspaces }) =>
          workspaces.authorizeCommand(request, command),
        ),
        null,
      );

      const issueControl = (mode: "workspace:observe" | "workspace:cancel") =>
        database.transaction(ownerId, ({ workspaces }) =>
          workspaces.issueControl(subjectId, command.operation, mode),
        );
      const observe = await issueControl("workspace:observe");
      const observeRequest = {
        ...request,
        token: observe.token,
        operation: "workspace:observe" as const,
      };
      const control = (value = observeRequest, operation = command.operation) =>
        database.transaction(ownerId, ({ workspaces }) =>
          workspaces.authorizeControl(value, operation),
        );
      assert.ok(await control());
      assert.equal(
        await control(observeRequest, { ...command.operation, operationId: randomUUID() }),
        null,
      );
      assert.equal(
        await control(observeRequest, { ...command.operation, inputHash: "b".repeat(64) }),
        null,
      );
      assert.equal(
        await database.transaction(ownerId, ({ workspaces }) =>
          workspaces.authorizeCommand(observeRequest, command),
        ),
        null,
      );
      assert.equal(
        await database.transaction(other, ({ workspaces }) =>
          workspaces.authorizeControl(observeRequest, command.operation),
        ),
        null,
      );
      await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE id = ${task.id}::uuid`;
      assert.equal(await authorize(), null);
      assert.ok(await control());
      await database.transaction(ownerId, ({ tasks }) => tasks.cancel(task.id, task.revision));
      const cancel = await issueControl("workspace:cancel");
      const cancelRequest = {
        ...request,
        token: cancel.token,
        operation: "workspace:cancel" as const,
      };
      assert.ok(
        await database.transaction(ownerId, ({ workspaces }) =>
          workspaces.authorizeControl(cancelRequest, command.operation),
        ),
      );
      assert.equal(await control({ ...observeRequest, token: cancel.token }), null);
      assert.equal(await authorize(), null);

      await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.setState(workspaceId, 1, "paused"),
      );
      assert.equal(await control(), null);
      const paused = await issueControl("workspace:observe");
      assert.ok(await control({ ...observeRequest, token: paused.token }));
      await database.transaction(ownerId, ({ capabilities }) => capabilities.revoke(paused.id));
      assert.equal(await control({ ...observeRequest, token: paused.token }), null);
      const expired = await issueControl("workspace:observe");
      await sql`UPDATE winston.service_capabilities SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${expired.id}::uuid`;
      assert.equal(await control({ ...observeRequest, token: expired.token }), null);
      await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.setState(workspaceId, 2, "retired"),
      );
      await assert.rejects(issueControl("workspace:cancel"), /unavailable/);
    } finally {
      await database.close();
    }
  });
});
