import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import {
  createDatabase,
  migrateDatabase,
  DeviceReservationError,
} from "@winston/adapters/database";
import { deviceCapabilitySchema, type DeviceMessage } from "@winston/contracts/devices";
import {
  deviceOutputByteLimit,
  deviceOutputChunkLimit,
} from "@winston/contracts/device-executions";
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
  const prepare = (target = device, operation = command, claimNow = true) =>
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
      const claim = claimNow ? await actions.claim(action.id, action.hash, task) : null;
      if (claimNow) assert.ok(claim?.claimed);
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
      return {
        id: action.id,
        hash: action.hash,
        token: claim?.claimed ? claim.token : "unclaimed",
        task,
        message,
      };
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

test("prepared device reservations roll back busy claims and serialize concurrent callers", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const f = await fixture(database);
      const occupied = await f.prepare();
      await f.reserve(occupied);
      const approved = await f.prepare(f.device, command, false);
      const { id, hash, task, message } = approved;
      const input = { id, hash, task, message };
      const reserve = (value = input) =>
        database.transaction(f.ownerId, ({ deviceExecutions }) =>
          deviceExecutions.reserveApproved(value),
        );
      await assert.rejects(
        () => reserve(),
        (error: unknown) => error instanceof DeviceReservationError && error.status === "busy",
      );
      const unchanged = await database.transaction(f.ownerId, ({ actions }) => actions.find(id));
      assert.equal(unchanged?.state, "approved");
      assert.equal(unchanged.dispatchTask, null);
      await f.receive(receipt(occupied.message, "succeeded", 0));
      assert.equal((await reserve({ ...input, hash: "0".repeat(64) })).status, "denied");
      assert.equal(
        (await reserve({ ...input, message: { ...message, deviceId: randomUUID() } })).status,
        "denied",
      );
      const [first, second] = await Promise.all([
        reserve(),
        reserve({ ...input, message: { ...message, messageId: randomUUID() } }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), ["existing", "reserved"]);
      assert.ok("execution" in first && "execution" in second);
      assert.deepEqual(first.execution, second.execution);
      const claimed = await database.transaction(f.ownerId, ({ actions }) => actions.find(id));
      assert.equal(claimed?.state, "dispatching");
      assert.deepEqual(claimed.dispatchTask, task);
      const { execution } = first;
      await f.receive(receipt(execution.message, "succeeded", 0));
      assert.equal((await reserve()).status, "existing");
      const other = await f.prepare(f.device, command, false);
      assert.equal(other.message.payload.kind, "execute");
      const expired = {
        ...other,
        message: { ...other.message, payload: { ...other.message.payload, deadline: 1 } },
      };
      await assert.rejects(
        () => reserve(expired),
        (error: unknown) => error instanceof DeviceReservationError && error.status === "denied",
      );
      const stillApproved = await database.transaction(f.ownerId, ({ actions }) =>
        actions.find(other.id),
      );
      assert.equal(stillApproved?.state, "approved");
      assert.equal(stillApproved.dispatchTask, null);
    } finally {
      await database.close();
    }
  });
});

test("device control plans stop lost authority without releasing reservations", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      for (const reason of [
        "cancel",
        "steer",
        "lease",
        "generation",
        "policy",
        "deadline",
      ] as const) {
        const f = await fixture(database);
        const proof = await f.prepare();
        assert.equal(proof.message.payload.kind, "execute");
        const executionId = proof.message.payload.executionId;
        await f.reserve(proof);
        const plan = () =>
          database.transaction(f.ownerId, ({ deviceExecutions }) =>
            deviceExecutions.planControls(f.device.session),
          );
        assert.deepEqual(await plan(), []);
        switch (reason) {
          case "cancel":
            await sql`UPDATE winston.actions SET cancellation_requested = true WHERE owner_id = ${f.ownerId}::uuid`;
            break;
          case "steer":
            await database.transaction(f.ownerId, ({ tasks }) =>
              tasks.steer(proof.task.id, proof.task.revision, "Changed direction"),
            );
            break;
          case "lease":
            await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${f.ownerId}::uuid`;
            break;
          case "generation":
            await sql`UPDATE winston.tasks SET document = jsonb_set(document, '{generation}', to_jsonb((document->>'generation')::integer + 1)) WHERE owner_id = ${f.ownerId}::uuid`;
            break;
          case "policy":
            await database.transaction(f.ownerId, ({ authorization }) =>
              authorization.put({
                target: { kind: "device", id: f.device.device.id, resource: null },
                operation: "device.command",
                decision: "deny",
                revision: 0,
              }),
            );
            break;
          case "deadline":
            await sql`UPDATE winston.device_executions SET deadline = clock_timestamp() - interval '1 second' WHERE owner_id = ${f.ownerId}::uuid`;
            break;
        }
        const controls = await plan();
        assert.equal(controls[0]?.payload.kind, "cancel", reason);
        assert.deepEqual(controls[0].payload, {
          kind: "cancel",
          executionId,
          taskId: proof.task.id,
          taskRevision: proof.task.revision,
        });
        assert.equal(controls[0].correlationId, proof.message.messageId);
        assert.equal(controls[0].sessionId, proof.message.sessionId);
        assert.ok(controls.every((message) => message.payload.kind !== "execute"));
        const record = await database.transaction(f.ownerId, ({ deviceExecutions }) =>
          deviceExecutions.find(executionId),
        );
        assert.equal(record?.state, reason === "deadline" ? "unknown" : "dispatching");
        const occupied = await sql<
          { slot: number }[]
        >`SELECT slot FROM winston.device_executions WHERE owner_id = ${f.ownerId}::uuid AND state IN ('dispatching', 'accepted', 'running', 'unknown')`;
        assert.equal(occupied.length, 1);
        await f.receive(receipt(proof.message, "canceled", 0));
        assert.deepEqual(await plan(), []);
      }
    } finally {
      await database.close();
    }
  });
});

test("device control plans fence sessions and throttle journal queries durably", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const f = await fixture(database);
      const proof = await f.prepare();
      assert.equal(proof.message.payload.kind, "execute");
      const executionId = proof.message.payload.executionId;
      await f.reserve(proof);
      const other = randomUUID();
      await database.transaction(other, ({ owners }) => owners.ensure());
      const plan = (session = f.device.session, owner = f.ownerId) =>
        database.transaction(owner, ({ deviceExecutions }) =>
          deviceExecutions.planControls(session),
        );
      assert.deepEqual(await plan(f.device.session, other), []);
      assert.deepEqual(await plan({ ...f.device.session, sessionId: randomUUID() }), []);
      const replacement = await database.transaction(f.ownerId, ({ deviceSessions }) =>
        deviceSessions.open(f.device.device.id, f.device.credential),
      );
      assert.ok(replacement);
      const session = {
        deviceId: replacement.deviceId,
        sessionId: replacement.sessionId,
        generation: replacement.generation,
      };
      assert.deepEqual(await plan(), []);
      const first = await plan(session);
      assert.equal(first.length, 1);
      assert.equal(first[0]?.payload.kind, "reconcile");
      assert.equal(first[0].sessionId, session.sessionId);
      assert.deepEqual(await plan(session), []);
      const saved = await database.transaction(f.ownerId, ({ deviceExecutions }) =>
        deviceExecutions.find(executionId),
      );
      assert.equal(saved?.state, "unknown");
      assert.ok(saved.reconciliation?.requestedAt);
      const query = first[0];
      assert.equal(query.payload.kind, "reconcile");
      const evidence = await database.transaction(f.ownerId, ({ deviceExecutions }) =>
        deviceExecutions.reconcile({
          ...query,
          messageId: randomUUID(),
          correlationId: query.messageId,
          payload: {
            kind: "reconciled",
            executionId,
            taskId: proof.task.id,
            taskRevision: proof.task.revision,
            state: "running",
            exitCode: null,
          },
        }),
      );
      assert.equal(evidence?.reconciliation?.requestedAt, saved.reconciliation.requestedAt);
      assert.deepEqual(await plan(session), []);
      await sql`UPDATE winston.device_executions SET document = jsonb_set(document, '{reconciliation,requestedAt}', to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE owner_id = ${f.ownerId}::uuid`;
      const next = await plan(session);
      assert.equal(next.length, 1);
      assert.notEqual(next[0]?.messageId, first[0].messageId);
      assert.deepEqual(await plan(session), []);
      await sql`UPDATE winston.device_sessions SET lease_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${f.ownerId}::uuid`;
      assert.deepEqual(await plan(session), []);
    } finally {
      await database.close();
    }
  });
});

test("command output enforces original authority, shared ordering, quotas and bounded reads", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const f = await fixture(database);
      const proof = await f.prepare();
      assert.equal(proof.message.payload.kind, "execute");
      const executionId = proof.message.payload.executionId;
      await f.reserve(proof);
      await f.receive(receipt(proof.message, "running", 0));
      const chunk = (
        sequence: number,
        text = "hello",
        stream: "stdout" | "stderr" = "stdout",
      ): DeviceMessage => ({
        ...proof.message,
        messageId: randomUUID(),
        correlationId: proof.message.messageId,
        payload: {
          kind: "output",
          executionId,
          taskId: proof.task.id,
          taskRevision: proof.task.revision,
          sequence,
          stream,
          text,
        },
      });
      const append = (message: DeviceMessage, owner = f.ownerId) =>
        database.transaction(owner, ({ deviceExecutions }) =>
          deviceExecutions.appendOutput(message),
        );
      const read = (after = -1, owner = f.ownerId) =>
        database.transaction(owner, ({ deviceExecutions }) =>
          deviceExecutions.listOutput(executionId, after),
        );
      const first = chunk(2);
      const other = randomUUID();
      await database.transaction(other, ({ owners }) => owners.ensure());
      assert.equal(await append(first, other), false);
      for (const changed of [
        { ...first, deviceId: randomUUID() },
        { ...first, sessionId: randomUUID() },
        { ...first, generation: first.generation + 1 },
        { ...first, correlationId: randomUUID() },
      ])
        assert.equal(await append(changed), false);
      assert.equal(first.payload.kind, "output");
      assert.equal(
        await append({ ...first, payload: { ...first.payload, taskId: randomUUID() } }),
        false,
      );
      assert.equal(await append(chunk(0)), false);
      assert.equal(await append(first), true);
      assert.equal(await append(chunk(2)), true);
      assert.equal(await append(chunk(2, "changed")), false);
      assert.equal(await append(chunk(1)), false);
      assert.equal(await f.receive(receipt(proof.message, "succeeded", 2)), null);
      assert.equal(await append(chunk(3, "diagnostic", "stderr")), true);
      assert.equal((await read(-1, other)).messages.length, 0);
      assert.deepEqual(
        (await read()).messages.map((message) => message.payload),
        [first.payload, chunk(3, "diagnostic", "stderr").payload],
      );
      const observer = createDatabase({ connectionString, onConnectionError: () => {} });
      try {
        assert.deepEqual(
          await observer.transaction(f.ownerId, ({ deviceExecutions }) =>
            deviceExecutions.listOutput(executionId),
          ),
          await read(),
        );
      } finally {
        await observer.close();
      }
      await f.receive(receipt(proof.message, "succeeded", 4));
      assert.equal(await append(chunk(5)), false);
      assert.equal(await append(first), true);
      await database.transaction(f.ownerId, ({ deviceSessions }) =>
        deviceSessions.open(f.device.device.id, f.device.credential),
      );
      assert.equal(await append(first), false);

      const bytesFixture = await fixture(database);
      const bytesProof = await bytesFixture.prepare();
      assert.equal(bytesProof.message.payload.kind, "execute");
      const bytesId = bytesProof.message.payload.executionId;
      await bytesFixture.reserve(bytesProof);
      const text = "😀".repeat(16_384);
      const byteChunk = (sequence: number, value = text): DeviceMessage => ({
        ...bytesProof.message,
        messageId: randomUUID(),
        correlationId: bytesProof.message.messageId,
        payload: {
          kind: "output",
          executionId: bytesId,
          taskId: bytesProof.task.id,
          taskRevision: bytesProof.task.revision,
          sequence,
          stream: "stdout",
          text: value,
        },
      });
      const byteAppend = (message: DeviceMessage) =>
        database.transaction(bytesFixture.ownerId, ({ deviceExecutions }) =>
          deviceExecutions.appendOutput(message),
        );
      const chunks = deviceOutputByteLimit / new TextEncoder().encode(text).byteLength;
      for (let index = 0; index < chunks; index += 1)
        assert.equal(await byteAppend(byteChunk(index)), true);
      assert.equal(await byteAppend(byteChunk(chunks, "x")), false);
      assert.equal(await byteAppend(byteChunk(0)), true);
      let after = -1;
      for (let index = 0; index < chunks; index += 1) {
        const page = await database.transaction(bytesFixture.ownerId, ({ deviceExecutions }) =>
          deviceExecutions.listOutput(bytesId, after),
        );
        assert.equal(page.messages.length, 1);
        assert.equal(page.afterSequence, index);
        assert.equal(page.hasMore, index < chunks - 1);
        after = page.afterSequence;
      }
      // Exercise the chunk boundary without thousands of redundant round trips.
      await sql`UPDATE winston.device_executions SET output_count = ${deviceOutputChunkLimit - 1} WHERE owner_id = ${bytesFixture.ownerId}::uuid`;
      assert.equal(await byteAppend(byteChunk(chunks, "")), true);
      assert.equal(await byteAppend(byteChunk(chunks + 1, "")), false);
      assert.equal(await byteAppend(byteChunk(chunks, "")), true);
      assert.equal(
        (await bytesFixture.receive(receipt(bytesProof.message, "failed", chunks + 2)))?.state,
        "failed",
      );
    } finally {
      await database.close();
    }
  });
});

test("metadata and listing share bounded file slots without taking the desktop slot", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const f = await fixture(database);
      const operations: Operation[] = [
        { kind: "file.metadata", path: "/fixtures/item" },
        { kind: "file.list", path: "/fixtures", limit: 200 },
        { kind: "file.read", path: "/fixtures/item", transferId: randomUUID() },
      ];
      const files = await Promise.all(
        operations.map((operation) => f.prepare(f.device, operation)),
      );
      const results = await Promise.all(files.map((proof) => f.reserve(proof)));
      assert.deepEqual(results.map((result) => result.status).sort(), [
        "busy",
        "reserved",
        "reserved",
      ]);
      assert.equal((await f.reserve(await f.prepare())).status, "reserved");
    } finally {
      await database.close();
    }
  });
});

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
      const action = await database.transaction(f.ownerId, ({ actions }) => actions.find(proof.id));
      assert.equal(action?.state, "succeeded");
      assert.equal(proof.message.payload.kind, "execute");
      const executionId = proof.message.payload.executionId;
      assert.equal(action.outcome?.providerReference, executionId);
      assert.deepEqual(
        await database.transaction(f.ownerId, ({ actions }) =>
          actions.reconcileDevice(executionId),
        ),
        action,
      );
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
      assert.equal(
        (await database.transaction(f.ownerId, ({ actions }) => actions.find(proof.id)))?.state,
        "unknown",
      );
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
      // Closing all sessions must not hide unfinished executions from recovery.
      await sql`UPDATE winston.device_sessions SET disconnected_at = clock_timestamp() WHERE owner_id = ${f.ownerId}::uuid`;
      assert.deepEqual(await database.deviceSessionOwners(), [f.ownerId]);
      assert.deepEqual(await database.deviceSessionOwners(f.ownerId), []);
      assert.equal(await expire(), 1);
      assert.deepEqual(await database.deviceSessionOwners(), []);
    } finally {
      await database.close();
    }
  });
});

test("fresh reconciliation queries fence replies and only terminal journal evidence releases a device", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const f = await fixture(database);
      const proof = await f.prepare();
      await f.reserve(proof);
      assert.equal(proof.message.payload.kind, "execute");
      const executionId = proof.message.payload.executionId;
      // Older persisted documents acquire the new optional evidence field on read.
      await sql`UPDATE winston.device_executions SET document = document - 'reconciliation' WHERE owner_id = ${f.ownerId}::uuid`;
      const restored = await database.transaction(f.ownerId, ({ deviceExecutions }) =>
        deviceExecutions.find(executionId),
      );
      assert.equal(restored?.reconciliation, null);

      const replacement = await database.transaction(f.ownerId, async ({ deviceSessions }) => {
        const opened = await deviceSessions.open(f.device.device.id, f.device.credential);
        assert.ok(opened);
        const session = {
          deviceId: opened.deviceId,
          sessionId: opened.sessionId,
          generation: opened.generation,
        };
        await deviceSessions.advertise(session, [...deviceCapabilitySchema.options]);
        await deviceSessions.heartbeat(session, "paused");
        return session;
      });
      const query = (session = replacement, owner = f.ownerId) =>
        database.transaction(owner, ({ deviceExecutions }) =>
          deviceExecutions.requestReconciliation(executionId, session),
        );
      const receive = (message: DeviceMessage, owner = f.ownerId) =>
        database.transaction(owner, ({ deviceExecutions }) => deviceExecutions.reconcile(message));
      const answer = (
        request: DeviceMessage,
        state: Extract<DeviceMessage["payload"], { kind: "reconciled" }>["state"],
      ): DeviceMessage => {
        assert.equal(request.payload.kind, "reconcile");
        return {
          ...request,
          messageId: randomUUID(),
          correlationId: request.messageId,
          payload: {
            kind: "reconciled",
            executionId: request.payload.executionId,
            taskId: request.payload.taskId,
            taskRevision: request.payload.taskRevision,
            state,
            exitCode: state === "succeeded" ? 0 : null,
          },
        };
      };
      assert.equal(await query(f.device.session), null);
      const other = randomUUID();
      await database.transaction(other, ({ owners }) => owners.ensure());
      assert.equal(await query(replacement, other), null);
      assert.equal(await query({ ...replacement, deviceId: randomUUID() }), null);
      const first = await query();
      assert.ok(first);
      assert.equal(first.payload.kind, "reconcile");
      assert.deepEqual(first.payload.operation, proof.message.payload.operation);
      const second = await query();
      assert.ok(second);
      assert.notEqual(second.messageId, first.messageId);
      assert.equal(await receive(answer(first, "succeeded")), null);
      const response = answer(second, "succeeded");
      for (const changed of [
        { ...response, correlationId: randomUUID() },
        { ...response, sessionId: randomUUID() },
        { ...response, deviceId: randomUUID() },
        { ...response, generation: response.generation + 1 },
      ])
        assert.equal(await receive(changed), null);
      assert.equal(await receive(response, other), null);
      assert.equal(response.payload.kind, "reconciled");
      assert.equal(
        await receive({ ...response, payload: { ...response.payload, taskId: randomUUID() } }),
        null,
      );
      assert.equal(
        await receive({
          ...response,
          payload: { ...response.payload, taskRevision: response.payload.taskRevision + 1 },
        }),
        null,
      );

      await database.transaction(f.ownerId, ({ deviceSessions }) =>
        deviceSessions.heartbeat(replacement, "ready"),
      );
      const blocked = await f.prepare({ ...f.device, session: replacement });
      for (const state of [
        "missing",
        "conflict",
        "unavailable",
        "running",
        "cancel_requested",
        "uncertain",
      ] as const) {
        const request = await query();
        assert.ok(request);
        const message = answer(request, state);
        const evidence = await receive(message);
        assert.equal(evidence?.state, "unknown", state);
        assert.deepEqual(await receive(message), evidence);
        assert.equal(await receive(answer(request, "succeeded")), null);
        assert.equal((await f.reserve(blocked)).status, "busy", state);
      }
      const finalQuery = await query();
      assert.ok(finalQuery);
      await database.transaction(f.ownerId, ({ tasks }) =>
        tasks.cancel(proof.task.id, proof.task.revision),
      );
      const observer = createDatabase({ connectionString, onConnectionError: () => {} });
      try {
        const persisted = await observer.transaction(f.ownerId, ({ deviceExecutions }) =>
          deviceExecutions.find(executionId),
        );
        assert.deepEqual(persisted?.reconciliation?.request, finalQuery);
      } finally {
        await observer.close();
      }
      const complete = answer(finalQuery, "succeeded");
      const final = await receive(complete);
      assert.equal(final?.state, "succeeded");
      const action = await database.transaction(f.ownerId, ({ actions }) => actions.find(proof.id));
      assert.equal(action?.state, "succeeded");
      assert.equal(action.outcome?.providerReference, executionId);
      assert.deepEqual(await receive(complete), final);
      assert.equal(await receive(answer(finalQuery, "failed")), null);
      assert.equal(await query(), null);
      assert.equal((await f.reserve(blocked)).status, "reserved");
      assert.equal(blocked.message.payload.kind, "execute");
      const blockedId = blocked.message.payload.executionId;
      const staleQuery = await database.transaction(f.ownerId, ({ deviceExecutions }) =>
        deviceExecutions.requestReconciliation(blockedId, replacement),
      );
      assert.ok(staleQuery);
      await sql`UPDATE winston.device_sessions SET lease_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${f.ownerId}::uuid`;
      assert.equal(await receive(answer(staleQuery, "succeeded")), null);
    } finally {
      await database.close();
    }
  });
});

test("device action outcomes preserve cancellation and reject mismatched persisted authority atomically", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      for (const state of ["failed", "canceled"] as const) {
        const f = await fixture(database);
        const proof = await f.prepare();
        assert.equal(proof.message.payload.kind, "execute");
        const executionId = proof.message.payload.executionId;
        await f.reserve(proof);
        await f.receive(receipt(proof.message, "running", 1));
        const original = await database.transaction(f.ownerId, ({ deviceExecutions }) =>
          deviceExecutions.find(executionId),
        );
        assert.ok(original);
        const other = randomUUID();
        await database.transaction(other, ({ owners }) => owners.ensure());
        assert.equal(
          await database.transaction(other, ({ actions }) => actions.reconcileDevice(executionId)),
          null,
        );
        // A mismatched reservation must not settle a different immutable action.
        for (const changed of [
          { ...original, actionId: randomUUID() },
          { ...original, task: { ...original.task, generation: original.task.generation + 1 } },
          { ...original, message: { ...original.message, deviceId: randomUUID() } },
          {
            ...original,
            message: {
              ...proof.message,
              payload: {
                ...proof.message.payload,
                operation: { ...command, executable: "/bin/false" },
              },
            },
          },
        ]) {
          await sql`UPDATE winston.device_executions SET document = ${JSON.stringify({ ...changed, state: "failed" })}::text::jsonb WHERE owner_id = ${f.ownerId}::uuid`;
          assert.equal(
            await database.transaction(f.ownerId, ({ actions }) =>
              actions.reconcileDevice(executionId),
            ),
            null,
          );
        }
        await sql`UPDATE winston.device_executions SET document = ${JSON.stringify(original)}::text::jsonb WHERE owner_id = ${f.ownerId}::uuid`;
        // Conflicting action authority rolls the receipt update back in the same transaction.
        await sql`UPDATE winston.actions SET document = jsonb_set(document, '{operationId}', to_jsonb(${randomUUID()}::text)) WHERE owner_id = ${f.ownerId}::uuid AND id = ${proof.id}::uuid`;
        const terminal = receipt(proof.message, state, 2);
        await assert.rejects(() => f.receive(terminal), /conflicts with its action/);
        assert.deepEqual(
          await database.transaction(f.ownerId, ({ deviceExecutions }) =>
            deviceExecutions.find(executionId),
          ),
          original,
        );
        await sql`UPDATE winston.actions SET document = jsonb_set(document, '{operationId}', to_jsonb(${executionId}::text)) WHERE owner_id = ${f.ownerId}::uuid AND id = ${proof.id}::uuid`;
        await f.receive(terminal);
        const action = await database.transaction(f.ownerId, ({ actions }) =>
          actions.find(proof.id),
        );
        assert.equal(action?.state, "failed");
        assert.equal(action.outcome?.providerReference, executionId);
        assert.match(action.outcome.detail, state === "canceled" ? /canceled/ : /failed/);
        assert.match(action.outcome.detail, /earlier effects may remain/);
        assert.equal(await f.receive(receipt(proof.message, "succeeded", 3)), null);
      }
    } finally {
      await database.close();
    }
  });
});
