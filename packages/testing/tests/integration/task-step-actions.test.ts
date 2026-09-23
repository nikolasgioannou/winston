import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("persisted workspace calls retain one action across concurrent preparation and worker recovery", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    try {
      const task = await database.transaction(ownerId, async ({ owners, tasks, workspaces }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Action fixture");
        await workspaces.setState(workspaceId, 0, "active");
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Run fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const worker = { id: task.id, revision: task.revision, generation: task.generation };
      const command = {
        argv: ["pwd"],
        cwd: "/data/home",
        env: {},
        timeoutMs: 1000,
        maxOutputBytes: 4096,
      };
      const step = await database.transaction(ownerId, ({ taskSteps }) =>
        taskSteps.append(worker, {
          key: "model:0",
          afterSequence: 0,
          payload: {
            kind: "model",
            text: "",
            calls: [
              { id: "valid", name: "workspace_command", input: { workspaceId, command } },
              {
                id: "invalid",
                name: "workspace_command",
                input: { workspaceId, command: { ...command, cwd: "relative" } },
              },
              { id: "different", name: "other_tool", input: {} },
            ],
          },
        }),
      );
      const prepare = (callId = "valid", scope = worker, id = step.id) =>
        database.transaction(ownerId, ({ taskSteps }) =>
          taskSteps.prepareWorkspace(scope, id, callId),
        );
      await assert.rejects(prepare("missing"), /unavailable/);
      await assert.rejects(prepare("different"), /unavailable/);
      await assert.rejects(prepare("invalid"));
      await assert.rejects(prepare("valid", worker, randomUUID()), /unavailable/);
      await assert.rejects(
        database.transaction(randomUUID(), ({ taskSteps }) =>
          taskSteps.prepareWorkspace(worker, step.id, "valid"),
        ),
        /unavailable/,
      );
      const [first, duplicate] = await Promise.all([prepare(), prepare()]);
      assert.deepEqual(first, duplicate);
      assert.deepEqual(first.request.arguments, command);
      const dispatch = await database.transaction(ownerId, ({ actions }) =>
        actions.claim(first.id, first.hash, worker),
      );
      assert.ok(dispatch?.claimed);
      await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      const reclaimed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(task.id, task.revision),
      );
      const recovery = {
        id: reclaimed.id,
        revision: reclaimed.revision,
        generation: reclaimed.generation,
      };
      await assert.rejects(prepare(), /lease/);
      const original = await prepare("valid", recovery);
      assert.equal(original.id, first.id);
      assert.equal(original.operationId, first.operationId);
      assert.equal(original.state, "dispatching");
      assert.deepEqual(original.request.task, worker);
      assert.equal(
        (
          await database.transaction(ownerId, ({ actions }) =>
            actions.claim(original.id, original.hash, recovery),
          )
        )?.claimed,
        false,
      );
      await database.transaction(ownerId, ({ actions }) =>
        actions.report(first.id, dispatch.token, {
          state: "succeeded",
          detail: "Fixture completed",
          providerReference: first.operationId,
        }),
      );
      assert.equal((await prepare("valid", recovery)).state, "succeeded");
      const changed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.steer(reclaimed.id, reclaimed.revision, "New intent"),
      );
      const claimed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(changed.id, changed.revision),
      );
      await assert.rejects(
        prepare("valid", {
          id: claimed.id,
          revision: claimed.revision,
          generation: claimed.generation,
        }),
        /unavailable/,
      );
      const count = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM winston.actions WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(count[0]?.count, 1);
    } finally {
      await database.close();
    }
  });
});
