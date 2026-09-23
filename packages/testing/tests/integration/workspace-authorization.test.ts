import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { AuthorizationRequest } from "@winston/contracts/authorization";
import { withTestPostgres } from "../../src/postgres";

test("workspace defaults require active ownership and respect rules and lifecycle revisions", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const owner = randomUUID();
    const stranger = randomUUID();
    const id = randomUUID();
    const request: AuthorizationRequest = {
      target: { kind: "workspace", id, resource: null },
      operation: "workspace.command",
    };
    const evaluate = (input = request) =>
      database.transaction(owner, ({ authorization }) => authorization.evaluate(input));

    try {
      await database.transaction(owner, ({ owners }) => owners.ensure());
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      await database.transaction(owner, ({ workspaces }) => workspaces.register(id, "Fixture"));
      assert.equal((await evaluate()).decision, "deny");
      await database.transaction(owner, ({ workspaces }) => workspaces.setState(id, 0, "active"));

      for (const operation of [
        "workspace.command",
        "workspace.file.read",
        "workspace.file.write",
      ] as const) {
        const result = await evaluate({ ...request, operation });
        assert.equal(result.decision, "allow");
        assert.equal(result.reason, "workspace_default");
      }
      assert.equal(
        (
          await database.transaction(stranger, ({ authorization }) =>
            authorization.evaluate(request),
          )
        ).decision,
        "deny",
      );
      assert.equal((await evaluate({ ...request, operation: "device.command" })).decision, "deny");
      assert.equal((await evaluate({ ...request, operation: "gmail.send" })).decision, "deny");
      assert.equal(
        (await evaluate({ ...request, target: { ...request.target, resource: "/" } })).decision,
        "deny",
      );

      const snapshot = (await evaluate()).snapshot;
      assert.ok(snapshot);
      const task = await database.transaction(owner, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Workspace authorization fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const action = await database.transaction(owner, ({ actions }) =>
        actions.prepare({
          key: randomUUID(),
          task: { id: task.id, revision: task.revision, generation: task.generation },
          authorization: request,
          arguments: { command: "echo fixture" },
        }),
      );
      assert.equal(action.state, "approved");
      await database.transaction(owner, ({ workspaces }) => workspaces.setState(id, 1, "paused"));
      assert.equal((await evaluate()).decision, "deny");
      await database.transaction(owner, ({ workspaces }) => workspaces.setState(id, 2, "active"));
      const dispatch = await database.transaction(owner, ({ actions }) =>
        actions.claim(action.id, action.hash, {
          id: task.id,
          revision: task.revision,
          generation: task.generation,
        }),
      );
      assert.equal(dispatch?.claimed, false);
      assert.equal(
        (
          await database.transaction(owner, ({ authorization }) =>
            authorization.evaluate(request, snapshot),
          )
        ).reason,
        "stale",
      );

      for (const [revision, decision] of (["ask", "deny", "allow"] as const).entries()) {
        assert.deepEqual(
          await database.transaction(owner, ({ authorization }) =>
            authorization.put({ ...request, revision, decision }),
          ),
          { revision: revision + 1 },
        );
        const result = await evaluate();
        assert.equal(result.decision, decision);
        assert.equal(result.reason, "rule");
      }
      await database.transaction(owner, ({ workspaces }) => workspaces.setState(id, 3, "retired"));
      assert.equal((await evaluate()).decision, "deny");
    } finally {
      await database.close();
    }
  });
});
