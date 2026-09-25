import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("device action keys survive approval and worker changes but preserve their exact target", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const ownerId = randomUUID();
      const setup = await database.transaction(ownerId, async ({ owners, devices, tasks }) => {
        await owners.ensure();
        const challenge = await devices.start("Preparation fixture");
        const pair = await devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["command"],
        });
        assert.ok(pair);
        const task = await tasks.create({
          key: randomUUID(),
          objective: "Prepare a device action",
          sourceMessageIds: [],
        });
        const running = await tasks.claim(task.id, task.revision);
        return {
          deviceId: pair.device.id,
          worker: { id: running.id, revision: running.revision, generation: running.generation },
        };
      });
      const operation = {
        kind: "command",
        executable: "/bin/echo",
        arguments: ["literal; $(input)"],
        directory: "/tmp",
      };
      const prepare = (
        worker = setup.worker,
        deviceId = setup.deviceId,
        input = operation,
        key = "same-request",
        owner = ownerId,
      ) =>
        database.transaction(owner, ({ deviceActions }) =>
          deviceActions.prepare(worker, key, deviceId, input),
        );
      const first = await prepare();
      assert.equal(first.state, "pending");
      assert.deepEqual(first.request.arguments, operation);
      assert.equal(first.dispatchTask, null);
      assert.equal((await prepare()).id, first.id);
      await assert.rejects(() => prepare(setup.worker, randomUUID()), /conflicts/);
      await assert.rejects(
        () => prepare(setup.worker, setup.deviceId, { ...operation, arguments: ["changed"] }),
        /conflicts/,
      );
      const waiting = await database.transaction(ownerId, ({ tasks }) =>
        tasks.finishStep(setup.worker.id, setup.worker.revision, setup.worker.generation, {
          state: "waiting",
          blocker: { kind: "approval", referenceId: first.id, detail: "Approval needed" },
        }),
      );
      await assert.rejects(() => prepare(), /stale or expired/);
      const worker = await database.transaction(ownerId, async ({ actions, tasks }) => {
        await actions.decide({
          id: first.id,
          revision: first.revision,
          hash: first.hash,
          approve: true,
        });
        const queued = await tasks.resume(waiting.id, waiting.revision, first.id);
        const running = await tasks.claim(queued.id, queued.revision);
        return { id: running.id, revision: running.revision, generation: running.generation };
      });
      const resumed = await prepare(worker);
      assert.equal(resumed.id, first.id);
      assert.equal(resumed.operationId, first.operationId);
      assert.equal(resumed.state, "approved");
      assert.equal(resumed.dispatchTask, null);
      const claimed = await database.transaction(ownerId, ({ actions }) =>
        actions.claim(resumed.id, resumed.hash, worker),
      );
      assert.ok(claimed?.claimed);
      const duplicate = await prepare(worker);
      assert.equal(duplicate.id, first.id);
      assert.equal(duplicate.state, "dispatching");
      assert.deepEqual(duplicate.dispatchTask, worker);
      const revised = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.steer(worker.id, worker.revision, "Another objective");
        const running = await tasks.claim(queued.id, queued.revision);
        return { id: running.id, revision: running.revision, generation: running.generation };
      });
      assert.notEqual((await prepare(revised)).id, first.id);
      await assert.rejects(() => prepare(worker), /stale or expired/);
      await assert.rejects(
        () => prepare(revised, randomUUID(), operation, "new-target"),
        /unavailable/,
      );
      await assert.rejects(
        () => prepare(revised, setup.deviceId, operation, ""),
        /Invalid device action key/,
      );
      const other = randomUUID();
      await database.transaction(other, ({ owners }) => owners.ensure());
      await assert.rejects(
        () => prepare(revised, setup.deviceId, operation, "same-request", other),
        /stale or expired/,
      );
      const foreignWorker = await database.transaction(other, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Another owner's task",
          sourceMessageIds: [],
        });
        const running = await tasks.claim(queued.id, queued.revision);
        return { id: running.id, revision: running.revision, generation: running.generation };
      });
      await assert.rejects(
        () => prepare(foreignWorker, setup.deviceId, operation, "same-request", other),
        /Device unavailable/,
      );
      await database.transaction(ownerId, async ({ devices }) => {
        const device = await devices.find(setup.deviceId);
        assert.ok(device);
        await devices.revoke(device.id, device.revision);
      });
      await assert.rejects(
        () => prepare(revised, setup.deviceId, operation, "after-revocation"),
        /Device unavailable/,
      );
      await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      await assert.rejects(() => prepare(revised), /stale or expired/);
    } finally {
      await database.close();
    }
  });
});
