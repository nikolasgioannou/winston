import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { AuthorizationRequest } from "@winston/contracts/authorization";
import { withTestPostgres } from "../../src/postgres";

test("task bindings survive worker renewal, isolate owners and require steering before target changes", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const foreign = randomUUID();
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await database.transaction(other, ({ owners }) => owners.ensure());
      for (const [owner, id] of [
        [ownerId, first],
        [ownerId, second],
        [other, foreign],
      ] as const) {
        await database.transaction(owner, async ({ workspaces }) => {
          await workspaces.register(id, "Binding fixture");
          await workspaces.setState(id, 0, "active");
        });
      }
      let task = await database.transaction(ownerId, ({ tasks }) =>
        tasks.create({
          key: randomUUID(),
          objective: "Use the selected workspace",
          sourceMessageIds: [],
        }),
      );
      const authorization: AuthorizationRequest = {
        target: { kind: "workspace", id: first, resource: null },
        operation: "workspace.command",
      };
      const bind = (request = authorization, key = "workspace") =>
        database.transaction(ownerId, ({ taskResources }) =>
          taskResources.bind({
            task: { id: task.id, revision: task.revision },
            key,
            authorization: request,
          }),
        );
      const original = await bind();
      const device = await database.transaction(ownerId, async ({ devices }) => {
        const challenge = await devices.start("Binding Mac");
        const paired = await devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["command"],
        });
        assert.ok(paired);
        return paired.device;
      });
      const deviceRequest: AuthorizationRequest = {
        target: { kind: "device", id: device.id, resource: null },
        operation: "device.command",
      };
      await bind(deviceRequest, "mac");
      await database.transaction(ownerId, ({ devices }) =>
        devices.revoke(device.id, device.revision),
      );
      await assert.rejects(bind(deviceRequest, "mac"), /unavailable/);
      assert.deepEqual(await bind(), original);
      await assert.rejects(
        bind({ ...authorization, target: { ...authorization.target, id: second } }),
        /Steer/,
      );
      await assert.rejects(
        bind({ ...authorization, target: { ...authorization.target, id: foreign } }, "foreign"),
        /unavailable/,
      );
      await assert.rejects(
        bind(
          { ...authorization, target: { ...authorization.target, id: randomUUID() } },
          "missing",
        ),
        /unavailable/,
      );
      // Distinct named selections support tasks intentionally using multiple resources.
      await bind(
        { ...authorization, target: { ...authorization.target, id: second } },
        "destination",
      );
      assert.equal(
        (
          await database.transaction(ownerId, ({ taskResources }) =>
            taskResources.list({ id: task.id, revision: task.revision }),
          )
        ).length,
        3,
      );
      await assert.rejects(
        database.transaction(other, ({ taskResources }) =>
          taskResources.find({ id: task.id, revision: task.revision }, "workspace"),
        ),
        /unavailable/,
      );
      task = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(task.id, task.revision),
      );
      const prepare = (target = authorization, bindingKey = "workspace") =>
        database.transaction(ownerId, ({ actions }) =>
          actions.prepare({
            key: randomUUID(),
            task: { id: task.id, revision: task.revision, generation: task.generation },
            authorization: target,
            bindingKey,
            arguments: {},
          }),
        );
      const action = await prepare();
      assert.equal(action.state, "approved");
      await assert.rejects(
        prepare({ ...authorization, target: { ...authorization.target, id: second } }),
        /binding/,
      );
      await assert.rejects(prepare(authorization, "absent"), /binding/);
      await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE id = ${task.id}::uuid`;
      task = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(task.id, task.revision),
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ taskResources }) =>
          taskResources.find({ id: task.id, revision: task.revision }, "workspace"),
        ),
        original,
      );
      await database.transaction(ownerId, ({ authorization: policy }) =>
        policy.put({ ...authorization, revision: 0, decision: "deny" }),
      );
      const rejected = await database.transaction(ownerId, ({ actions }) =>
        actions.claim(action.id, action.hash, {
          id: task.id,
          revision: task.revision,
          generation: task.generation,
        }),
      );
      assert.equal(rejected?.action.state, "invalidated");
      await assert.rejects(bind(), /denied/);
      task = await database.transaction(ownerId, ({ tasks }) =>
        tasks.steer(task.id, task.revision, "Use the other workspace"),
      );
      assert.equal(
        await database.transaction(ownerId, ({ taskResources }) =>
          taskResources.find({ id: task.id, revision: task.revision }, "workspace"),
        ),
        undefined,
      );
      const changed = await bind({
        ...authorization,
        target: { ...authorization.target, id: second },
      });
      assert.equal(changed.intentRevision, original.intentRevision + 1);
      assert.equal(changed.authorization.target.id, second);
      await database.transaction(ownerId, ({ tasks }) => tasks.cancel(task.id, task.revision));
      const canceled = await database.transaction(ownerId, ({ tasks }) => tasks.find(task.id));
      assert.ok(canceled);
      task = canceled;
      await assert.rejects(
        bind({ ...authorization, target: { ...authorization.target, id: second } }),
        /terminal/,
      );
    } finally {
      await database.close();
    }
  });
});
