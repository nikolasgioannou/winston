import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { deviceCapabilitySchema, type DeviceMessage } from "@winston/contracts/devices";
import { withTestPostgres } from "../../src/postgres";

type Operation = Extract<DeviceMessage["payload"], { kind: "execute" }>["operation"];
const command: Operation = {
  kind: "command",
  executable: "/bin/echo",
  arguments: [],
  directory: "/tmp",
};

async function fixture(database: ReturnType<typeof createDatabase>) {
  const ownerId = randomUUID();
  await database.transaction(ownerId, ({ owners }) => owners.ensure());
  const pair = () =>
    database.transaction(ownerId, async ({ devices, deviceSessions }) => {
      const challenge = await devices.start("Reservation fixture");
      const paired = await devices.pair(challenge.secret, {
        platform: "macos",
        appVersion: "0.1.0",
        protocolVersion: 1,
        capabilities: [...deviceCapabilitySchema.options],
      });
      assert.ok(paired);
      const opened = await deviceSessions.open(paired.device.id, paired.credential);
      assert.ok(opened);
      const session = {
        deviceId: opened.deviceId,
        sessionId: opened.sessionId,
        generation: opened.generation,
      };
      await deviceSessions.advertise(session, [...deviceCapabilitySchema.options]);
      await deviceSessions.heartbeat(session, "ready");
      return { ...paired, session };
    });
  const device = await pair();
  const prepare = (target = device, operation = command) =>
    database.transaction(ownerId, async ({ tasks, actions }) => {
      const queued = await tasks.create({
        key: randomUUID(),
        objective: "Reserve a test device",
        sourceMessageIds: [],
      });
      const running = await tasks.claim(queued.id, queued.revision);
      const task = { id: running.id, revision: running.revision, generation: running.generation };
      const action = await actions.prepare({
        key: randomUUID(),
        task,
        arguments: operation,
        authorization: {
          target: { kind: "device", id: target.device.id, resource: null },
          operation: `device.${operation.kind}`,
        },
      });
      await actions.decide({
        id: action.id,
        revision: action.revision,
        hash: action.hash,
        approve: true,
      });
      const claim = await actions.claim(action.id, action.hash, task);
      assert.ok(claim?.claimed);
      const message: DeviceMessage = {
        version: 1,
        messageId: randomUUID(),
        correlationId: randomUUID(),
        ...target.session,
        payload: {
          kind: "execute",
          executionId: action.operationId,
          taskId: task.id,
          taskRevision: task.revision,
          deadline: Date.now() + 60_000,
          operation,
        },
      };
      return { id: action.id, token: claim.token, task, message };
    });
  const reserve = (proof: Awaited<ReturnType<typeof prepare>>, owner = ownerId) =>
    database.transaction(owner, ({ deviceExecutions }) => deviceExecutions.reserve(proof));
  const receive = (message: DeviceMessage, owner = ownerId) =>
    database.transaction(owner, ({ deviceExecutions }) => deviceExecutions.receipt(message));
  return { ownerId, device, pair, prepare, reserve, receive };
}

function receipt(
  message: DeviceMessage,
  state: "accepted" | "running" | "succeeded" | "failed" | "canceled",
  sequence: number,
): DeviceMessage {
  assert.equal(message.payload.kind, "execute");
  const payload = message.payload;
  return {
    ...message,
    messageId: randomUUID(),
    correlationId: message.messageId,
    payload: {
      kind: "status",
      executionId: payload.executionId,
      taskId: payload.taskId,
      taskRevision: payload.taskRevision,
      sequence,
      state,
      exitCode: state === "succeeded" ? 0 : null,
    },
  };
}

test("device reservations serialize desktop work, bound file work and never grant duplicate sends", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const f = await fixture(database);
      const first = await f.prepare();
      const second = await f.prepare();
      const results = await Promise.all([f.reserve(first), f.reserve(second)]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["busy", "reserved"]);
      const winner = results[0].status === "reserved" ? first : second;
      const blocked = winner === first ? second : first;
      assert.equal((await f.reserve(winner)).status, "existing");
      const observer = createDatabase({ connectionString, onConnectionError: () => {} });
      try {
        assert.equal(winner.message.payload.kind, "execute");
        const executionId = winner.message.payload.executionId;
        const persisted = await observer.transaction(f.ownerId, ({ deviceExecutions }) =>
          deviceExecutions.find(executionId),
        );
        assert.equal(persisted?.state, "dispatching");
        assert.deepEqual(persisted.message, winner.message);
      } finally {
        await observer.close();
      }
      assert.equal((await f.reserve({ ...winner, token: "wrong" })).status, "denied");
      await assert.rejects(
        () => f.reserve({ ...winner, message: { ...winner.message, messageId: randomUUID() } }),
        /conflicts/,
      );
      const other = randomUUID();
      await database.transaction(other, ({ owners }) => owners.ensure());
      assert.equal((await f.reserve(winner, other)).status, "denied");
      const differentDevice = await f.prepare(await f.pair());
      assert.equal((await f.reserve(differentDevice)).status, "reserved");

      const files = await Promise.all(
        [0, 1, 2].map(() =>
          f.prepare(f.device, {
            kind: "file.read",
            path: "/tmp/fixture",
            transferId: randomUUID(),
          }),
        ),
      );
      const fileResults = await Promise.all(files.map((proof) => f.reserve(proof)));
      assert.deepEqual(fileResults.map((result) => result.status).sort(), [
        "busy",
        "reserved",
        "reserved",
      ]);
      assert.equal((await f.reserve(blocked)).status, "busy");
      assert.equal((await f.receive(receipt(winner.message, "succeeded", 1)))?.state, "succeeded");
      assert.equal((await f.reserve(blocked)).status, "reserved");
    } finally {
      await database.close();
    }
  });
});

test("device receipts require the original binding and ordered evidence, including after task cancellation", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const f = await fixture(database);
      const proof = await f.prepare();
      assert.equal((await f.reserve(proof)).status, "reserved");
      const running = receipt(proof.message, "running", 2);
      for (const changed of [
        { ...running, deviceId: randomUUID() },
        { ...running, sessionId: randomUUID() },
        { ...running, generation: running.generation + 1 },
        { ...running, correlationId: randomUUID() },
      ])
        assert.equal(await f.receive(changed), null);
      assert.equal(running.payload.kind, "status");
      assert.equal(
        await f.receive({ ...running, payload: { ...running.payload, taskId: randomUUID() } }),
        null,
      );
      assert.equal(
        await f.receive({
          ...running,
          payload: { ...running.payload, taskRevision: proof.task.revision + 1 },
        }),
        null,
      );
      assert.equal(
        await f.receive({ ...running, payload: { ...running.payload, exitCode: 0 } }),
        null,
      );
      const accepted = await f.receive(running);
      assert.equal(accepted?.state, "running");
      assert.deepEqual(await f.receive(running), accepted);
      assert.equal(await f.receive(receipt(proof.message, "accepted", 1)), null);
      assert.equal(await f.receive(receipt(proof.message, "accepted", 3)), null);
      await database.transaction(f.ownerId, async ({ tasks, deviceSessions }) => {
        await tasks.cancel(proof.task.id, proof.task.revision);
        await deviceSessions.heartbeat(f.device.session, "paused");
      });
      const complete = receipt(proof.message, "succeeded", 4);
      const final = await f.receive(complete);
      assert.equal(final?.state, "succeeded");
      assert.deepEqual(await f.receive(complete), final);
      assert.equal(await f.receive(receipt(proof.message, "failed", 5)), null);
      assert.equal(await f.receive(receipt(proof.message, "running", 6)), null);
    } finally {
      await database.close();
    }
  });
});

test("expired or disconnected executions retain resources until trustworthy completion", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const f = await fixture(database);
      const proof = await f.prepare();
      const blocked = await f.prepare();
      await f.reserve(proof);
      await sql`UPDATE winston.device_executions SET deadline = clock_timestamp() - interval '1 second' WHERE owner_id = ${f.ownerId}::uuid`;
      const expire = () =>
        database.transaction(f.ownerId, ({ deviceExecutions }) => deviceExecutions.expire());
      assert.equal(await expire(), 1);
      assert.equal(await expire(), 0);
      assert.equal((await f.reserve(blocked)).status, "busy");
      assert.equal((await f.receive(receipt(proof.message, "running", 1)))?.state, "unknown");
      assert.equal((await f.reserve(blocked)).status, "busy");
      assert.equal((await f.receive(receipt(proof.message, "failed", 2)))?.state, "failed");
      assert.equal((await f.reserve(blocked)).status, "reserved");
      const replacement = await database.transaction(f.ownerId, async ({ deviceSessions }) => {
        const session = await deviceSessions.open(f.device.device.id, f.device.credential);
        assert.ok(session);
        const identity = {
          deviceId: session.deviceId,
          sessionId: session.sessionId,
          generation: session.generation,
        };
        await deviceSessions.advertise(identity, [...deviceCapabilitySchema.options]);
        await deviceSessions.heartbeat(identity, "ready");
        return identity;
      });
      assert.equal(await expire(), 1);
      assert.equal(await f.receive(receipt(blocked.message, "succeeded", 1)), null);
      assert.equal(
        await f.receive({ ...receipt(blocked.message, "succeeded", 1), ...replacement }),
        null,
      );
      const later = await f.prepare({ ...f.device, session: replacement });
      assert.equal((await f.reserve(later)).status, "busy");
      const unrelated = await f.prepare(await f.pair());
      assert.equal((await f.reserve(unrelated)).status, "reserved");
    } finally {
      await database.close();
    }
  });
});
