import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { DeviceMessage } from "@winston/contracts/devices";
import { withTestPostgres } from "../../src/postgres";

async function fixture(database: ReturnType<typeof createDatabase>) {
  const ownerId = randomUUID();
  const paired = await database.transaction(ownerId, async ({ owners, devices }) => {
    await owners.ensure();
    const challenge = await devices.start("Dispatch fixture");
    const result = await devices.pair(challenge.secret, {
      platform: "macos",
      appVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["command"],
    });
    assert.ok(result);
    return result;
  });
  const open = () =>
    database.transaction(ownerId, async ({ deviceSessions }) => {
      const result = await deviceSessions.open(paired.device.id, paired.credential);
      assert.ok(result);
      const identity = {
        deviceId: result.deviceId,
        sessionId: result.sessionId,
        generation: result.generation,
      };
      await deviceSessions.advertise(identity, ["command"]);
      await deviceSessions.heartbeat(identity, "ready");
      return identity;
    });
  const session = await open();
  const task = await database.transaction(ownerId, async ({ tasks }) => {
    const queued = await tasks.create({
      key: randomUUID(),
      objective: "Device authorization fixture",
      sourceMessageIds: [],
    });
    const running = await tasks.claim(queued.id, queued.revision);
    return { id: running.id, revision: running.revision, generation: running.generation };
  });
  const operation = {
    kind: "command" as const,
    executable: "/bin/echo",
    arguments: ["literal; $(not-expanded)"],
    directory: "/tmp",
  };
  const authorization = {
    target: { kind: "device" as const, id: paired.device.id, resource: null },
    operation: "device.command" as const,
  };
  const action = await database.transaction(ownerId, ({ actions }) =>
    actions.prepare({ key: randomUUID(), task, authorization, arguments: operation }),
  );
  assert.equal(action.state, "pending");
  await database.transaction(ownerId, ({ actions }) =>
    actions.decide({ id: action.id, revision: action.revision, hash: action.hash, approve: true }),
  );
  const claim = await database.transaction(ownerId, ({ actions }) =>
    actions.claim(action.id, action.hash, task),
  );
  assert.ok(claim?.claimed);
  const message: DeviceMessage = {
    version: 1,
    messageId: randomUUID(),
    correlationId: randomUUID(),
    ...session,
    payload: {
      kind: "execute",
      executionId: action.operationId,
      taskId: task.id,
      taskRevision: task.revision,
      deadline: Date.now() + 60_000,
      operation,
    },
  };
  const proof = { id: action.id, token: claim.token, task, message };
  const check = (input = proof, owner = ownerId) =>
    database.transaction(owner, ({ actions }) => actions.authorizeDevice(input));
  assert.equal(await check(), true);
  return { ownerId, paired, task, session, action, authorization, proof, check, open };
}

test("device dispatch proofs bind exact approved input, worker, execution and session", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const f = await fixture(database);
      const before = await database.transaction(f.ownerId, ({ actions }) =>
        actions.find(f.action.id),
      );
      const original = f.proof.message;
      assert.equal(original.payload.kind, "execute");
      const payload = original.payload;
      assert.equal(await f.check({ ...f.proof, token: "wrong" }), false);
      assert.equal(await f.check({ ...f.proof, id: randomUUID() }), false);
      const other = randomUUID();
      await database.transaction(other, ({ owners }) => owners.ensure());
      assert.equal(await f.check(f.proof, other), false);
      for (const task of [
        { ...f.task, id: randomUUID() },
        { ...f.task, revision: f.task.revision + 1 },
        { ...f.task, generation: f.task.generation + 1 },
      ])
        assert.equal(await f.check({ ...f.proof, task }), false);

      const messages: DeviceMessage[] = [
        { ...original, deviceId: randomUUID() },
        { ...original, sessionId: randomUUID() },
        { ...original, generation: original.generation + 1 },
        { ...original, payload: { kind: "heartbeat", status: "ready" } },
        { ...original, payload: { ...payload, executionId: randomUUID() } },
        { ...original, payload: { ...payload, taskId: randomUUID() } },
        { ...original, payload: { ...payload, taskRevision: payload.taskRevision + 1 } },
        { ...original, payload: { ...payload, deadline: Date.now() - 1 } },
      ];
      for (const message of messages) assert.equal(await f.check({ ...f.proof, message }), false);
      if (payload.operation.kind !== "command") throw new Error("Expected command");
      for (const changed of [
        { ...payload.operation, executable: "/bin/sh" },
        { ...payload.operation, directory: "/" },
        { ...payload.operation, arguments: ["changed"] },
        { kind: "file.read" as const, path: "/tmp/example", transferId: randomUUID() },
      ])
        assert.equal(
          await f.check({
            ...f.proof,
            message: { ...original, payload: { ...payload, operation: changed } },
          }),
          false,
        );
      assert.equal(await f.check(), true);
      // Checking a proof never consumes a dispatch or changes the journal outcome.
      assert.deepEqual(
        await database.transaction(f.ownerId, ({ actions }) => actions.find(f.action.id)),
        before,
      );
    } finally {
      await database.close();
    }
  });
});

test("device dispatch rechecks live readiness, revocation, policy and task authority", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const f = await fixture(database);
      for (const status of ["paused", "locked", "sleeping"]) {
        await database.transaction(f.ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(f.session, status),
        );
        assert.equal(await f.check(), false);
      }
      await database.transaction(f.ownerId, ({ deviceSessions }) =>
        deviceSessions.heartbeat(f.session, "ready"),
      );
      assert.equal(await f.check(), true);
      await f.open();
      assert.equal(await f.check(), false);

      for (const change of [
        "capabilities",
        "device-expiry",
        "credential",
        "revoked",
        "policy",
        "steering",
        "cancel",
        "task-expiry",
        "unknown",
        "completed",
      ]) {
        const next = await fixture(database);
        const { ownerId, paired, task, action } = next;
        switch (change) {
          case "capabilities":
            await database.transaction(ownerId, ({ deviceSessions }) =>
              deviceSessions.advertise(next.session, []),
            );
            break;
          case "device-expiry":
            await sql`UPDATE winston.device_sessions SET lease_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
            break;
          case "credential":
            await sql`UPDATE winston.devices SET token_hash = ${"a".repeat(64)} WHERE owner_id = ${ownerId}::uuid`;
            break;
          case "revoked":
            await database.transaction(ownerId, ({ devices }) =>
              devices.revoke(paired.device.id, paired.device.revision),
            );
            break;
          case "policy":
            await database.transaction(ownerId, ({ authorization }) =>
              authorization.put({ ...next.authorization, decision: "deny", revision: 0 }),
            );
            break;
          case "steering":
            await database.transaction(ownerId, ({ tasks }) =>
              tasks.steer(task.id, task.revision, "A different request"),
            );
            break;
          case "cancel":
            await database.transaction(ownerId, ({ tasks }) =>
              tasks.cancel(task.id, task.revision),
            );
            break;
          case "task-expiry":
            await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
            break;
          case "unknown":
          case "completed":
            await database.transaction(ownerId, ({ actions }) =>
              actions.report(action.id, next.proof.token, {
                state: change === "unknown" ? "unknown" : "succeeded",
                detail: "Synthetic executor receipt",
                providerReference: null,
              }),
            );
        }
        assert.equal(await next.check(), false, change);
      }
    } finally {
      await database.close();
    }
  });
});
