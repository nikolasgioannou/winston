import assert from "node:assert/strict";
import { test } from "bun:test";
import type { OwnerTransaction } from "@winston/adapters/database";
import {
  deviceSessionSchema,
  type DeviceSessionIdentity,
} from "@winston/contracts/device-registry";
import {
  decodeDeviceMessage,
  encodeDeviceMessage,
  type DeviceMessage,
} from "@winston/contracts/devices";
import { createDeviceSocketTransport, type DeviceSocketScope } from "../src/devices/socket";
import { startServer } from "../src/host";
import type { DeviceExecution } from "@winston/contracts/device-executions";

const rejectedEvidence: DeviceSocketScope["deviceExecutions"] = {
  reserve: () => Promise.resolve({ status: "denied" }),
  appendOutput: () => Promise.resolve(false),
  receipt: () => Promise.resolve(null),
  reconcile: () => Promise.resolve(null),
  expire: () => Promise.resolve(0),
};

test("execution dispatch and evidence remain owner scoped and bound to the exact session", async () => {
  for (const mode of ["accepted", "rejected", "spoofed"] as const) {
    const ownerId = crypto.randomUUID();
    const session = {
      deviceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      generation: 1,
    };
    const task = { id: crypto.randomUUID(), revision: 1, generation: 1 };
    const message: DeviceMessage = {
      version: 1,
      ...session,
      messageId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      payload: {
        kind: "execute",
        executionId: crypto.randomUUID(),
        taskId: task.id,
        taskRevision: task.revision,
        deadline: Date.now() + 60_000,
        operation: { kind: "command", executable: "/bin/true", arguments: [], directory: "/tmp" },
      },
    };
    assert.equal(message.payload.kind, "execute");
    const record: DeviceExecution = {
      actionId: crypto.randomUUID(),
      task,
      message,
      state: "running",
      receipt: null,
      reconciliation: null,
    };
    const status: DeviceMessage = {
      ...message,
      correlationId: message.messageId,
      messageId: crypto.randomUUID(),
      payload: {
        kind: "status",
        executionId: message.payload.executionId,
        taskId: task.id,
        taskRevision: task.revision,
        sequence: 1,
        state: "running",
        exitCode: null,
      },
    };
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const calls: string[] = [];
    const serverIdentity = { serverId: crypto.randomUUID(), machineId: "12345678abcdef" };
    let reservations = 0;
    const scope: DeviceSocketScope = {
      deviceSessions: {
        open: (_device, _credential, server) => {
          assert.deepEqual(server, serverIdentity);
          return Promise.resolve({
            ...session,
            expiresAt: new Date(Date.now() + 45_000).toISOString(),
          });
        },
        route: () => Promise.resolve({ ...session, server: serverIdentity }),
        advertise: () => Promise.resolve(true),
        supports: () => Promise.resolve(false),
        heartbeat: () => {
          calls.push("heartbeat");
          return Promise.resolve(true);
        },
        close: () => {
          calls.push("close");
          return Promise.resolve(true);
        },
        expire: () => Promise.resolve(0),
        presence: () => Promise.resolve([]),
      },
      deviceExecutions: {
        reserve: () => {
          reservations += 1;
          return Promise.resolve({
            status: reservations === 1 ? "reserved" : "existing",
            execution: record,
          });
        },
        appendOutput: (received) => {
          assert.equal(received.payload.kind, "output");
          calls.push("output");
          return Promise.resolve(true);
        },
        receipt: async (received) => {
          assert.deepEqual(received, status);
          calls.push("status");
          entered.resolve(undefined);
          await release.promise;
          return mode === "accepted" ? record : null;
        },
        reconcile: (received) => {
          assert.equal(received.payload.kind, "reconciled");
          calls.push("reconciled");
          return Promise.resolve(record);
        },
        expire: () => {
          calls.push("expire");
          return Promise.resolve(1);
        },
      },
    };
    const transport = createDeviceSocketTransport(
      {
        authenticateDevice: () => Promise.resolve({ ownerId, deviceId: session.deviceId }),
        transaction: <Result>(id: string, work: (scope: DeviceSocketScope) => Promise<Result>) => {
          assert.equal(id, ownerId);
          return work(scope);
        },
      },
      serverIdentity,
    );
    const host = startServer(
      { hostname: "127.0.0.1", port: 0, shutdownTimeoutMs: 1000 },
      { deviceTransport: transport },
    );
    const socket = new WebSocket(`ws://127.0.0.1:${String(host.server.port)}/api/devices/socket`, {
      headers: { Authorization: `Bearer wdi_${"a".repeat(43)}` },
    });
    try {
      await received(socket);
      const proof = { id: record.actionId, token: "test-proof", task, message };
      assert.equal((await transport.dispatch(crypto.randomUUID(), proof)).status, "unavailable");
      assert.equal(
        (
          await transport.dispatch(ownerId, {
            ...proof,
            message: { ...message, sessionId: crypto.randomUUID() },
          })
        ).status,
        "unavailable",
      );
      const outbound = received(socket);
      assert.equal((await transport.dispatch(ownerId, proof)).status, "sent");
      assert.deepEqual(decodeDeviceMessage(await outbound), message);
      assert.equal((await transport.dispatch(ownerId, proof)).status, "existing");
      assert.equal(reservations, 2);
      const closed = disconnected(socket);
      socket.send(
        encodeDeviceMessage(
          mode === "spoofed" ? { ...status, sessionId: crypto.randomUUID() } : status,
        ),
      );
      if (mode !== "spoofed") {
        await entered.promise;
        socket.send(
          encodeDeviceMessage({
            ...status,
            messageId: crypto.randomUUID(),
            payload: {
              kind: "output",
              executionId: message.payload.executionId,
              taskId: task.id,
              taskRevision: task.revision,
              sequence: 2,
              stream: "stdout",
              text: "fixture",
            },
          }),
        );
        socket.send(
          encodeDeviceMessage({
            ...status,
            messageId: crypto.randomUUID(),
            payload: {
              kind: "reconciled",
              executionId: message.payload.executionId,
              taskId: task.id,
              taskRevision: task.revision,
              state: "uncertain",
              exitCode: null,
            },
          }),
        );
        const acknowledgment = mode === "accepted" ? received(socket) : undefined;
        socket.send(
          encodeDeviceMessage({ ...status, payload: { kind: "heartbeat", status: "ready" } }),
        );
        assert.deepEqual(calls, ["status"]);
        release.resolve(undefined);
        if (acknowledgment) {
          assert.equal(decodeDeviceMessage(await acknowledgment).payload.kind, "heartbeat");
          assert.deepEqual(calls, ["status", "output", "reconciled", "heartbeat"]);
          socket.close();
        }
      }
      await closed;
      await transport.stop();
      assert.deepEqual(
        calls,
        mode === "accepted"
          ? ["status", "output", "reconciled", "heartbeat", "close", "expire"]
          : mode === "rejected"
            ? ["status", "close", "expire"]
            : ["close", "expire"],
      );
    } finally {
      release.resolve(undefined);
      socket.close();
      await host.stop();
    }
  }
}, 10_000);

function received(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string") resolve(event.data);
        else reject(new Error("Expected text frame"));
      },
      { once: true },
    );
  });
}

function disconnected(socket: WebSocket) {
  return new Promise<void>((resolve) => {
    socket.addEventListener(
      "close",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

test("proxy sockets serialize advertisements and heartbeats and discard overflow on close", async () => {
  for (const overflow of [false, true]) {
    const ownerId = crypto.randomUUID();
    const session = {
      deviceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      generation: 1,
    };
    const entered = Promise.withResolvers<undefined>();
    const blocked = Promise.withResolvers<undefined>();
    const calls: string[] = [];
    const sessions: OwnerTransaction["deviceSessions"] = {
      route: () => Promise.resolve(null),
      open: () =>
        Promise.resolve({ ...session, expiresAt: new Date(Date.now() + 45_000).toISOString() }),
      advertise: async (_session, capabilities) => {
        calls.push(`capabilities:${capabilities.join(",")}`);
        entered.resolve(undefined);
        await blocked.promise;
        return true;
      },
      heartbeat: (_session, status) => {
        calls.push(`heartbeat:${status}`);
        return Promise.resolve(true);
      },
      supports: () => Promise.resolve(false),
      close: () => Promise.resolve(true),
      expire: () => Promise.resolve(0),
      presence: () => Promise.resolve([]),
    };
    const transport = createDeviceSocketTransport({
      authenticateDevice: () => Promise.resolve({ ownerId, deviceId: session.deviceId }),
      transaction: <Result>(_owner: string, work: (scope: DeviceSocketScope) => Promise<Result>) =>
        work({ deviceSessions: sessions, deviceExecutions: rejectedEvidence }),
    });
    const host = startServer(
      { hostname: "127.0.0.1", port: 0, shutdownTimeoutMs: 1000 },
      { deviceTransport: transport },
    );
    const socket = new WebSocket(`ws://127.0.0.1:${String(host.server.port)}/api/devices/socket`, {
      headers: { Authorization: `Bearer wdi_${"a".repeat(43)}` },
    });
    const send = (payload: DeviceMessage["payload"]) => {
      socket.send(
        encodeDeviceMessage({
          version: 1,
          ...session,
          messageId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          payload,
        }),
      );
    };
    try {
      await received(socket);
      send({ kind: "capabilities", capabilities: ["command"] });
      await entered.promise;
      if (overflow) {
        const closed = disconnected(socket);
        for (let index = 0; index < 33; index += 1) send({ kind: "heartbeat", status: "ready" });
        await closed;
        blocked.resolve(undefined);
        assert.deepEqual(calls, ["capabilities:command"]);
      } else {
        const replies: DeviceMessage[] = [];
        const finished = Promise.withResolvers<undefined>();
        socket.addEventListener("message", (event: MessageEvent<string>) => {
          replies.push(decodeDeviceMessage(event.data));
          if (replies.length === 2) finished.resolve(undefined);
        });
        send({ kind: "heartbeat", status: "ready" });
        send({ kind: "capabilities", capabilities: [] });
        send({ kind: "heartbeat", status: "paused" });
        assert.deepEqual(calls, ["capabilities:command"]);
        blocked.resolve(undefined);
        await finished.promise;
        assert.deepEqual(calls, [
          "capabilities:command",
          "heartbeat:ready",
          "capabilities:",
          "heartbeat:paused",
        ]);
        assert.deepEqual(
          replies.map((reply) => reply.payload),
          [
            { kind: "heartbeat", status: "ready" },
            { kind: "heartbeat", status: "paused" },
          ],
        );
      }
    } finally {
      blocked.resolve(undefined);
      socket.close();
      await host.stop();
    }
  }
}, 10_000);

test("proxy sockets authenticate, acknowledge fenced heartbeats and close invalid sessions", async () => {
  const ownerId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const credential = `wdi_${"a".repeat(43)}`;
  let generation = 0;
  let heartbeats = 0;
  let closed = 0;
  let current: DeviceSessionIdentity | undefined;
  const sessions: OwnerTransaction["deviceSessions"] = {
    route: () => Promise.resolve(null),
    advertise: () => Promise.resolve(true),
    supports: () => Promise.resolve(false),
    open: () => {
      current = { deviceId, sessionId: crypto.randomUUID(), generation: ++generation };
      return Promise.resolve({
        ...current,
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      });
    },
    heartbeat: (session) => {
      heartbeats += 1;
      return Promise.resolve(session.sessionId === current?.sessionId);
    },
    close: (session) => {
      closed += 1;
      return Promise.resolve(session.sessionId === current?.sessionId);
    },
    expire: () => Promise.resolve(0),
    presence: () => Promise.resolve([]),
  };
  const transport = createDeviceSocketTransport({
    authenticateDevice: (token) =>
      Promise.resolve(token === credential ? { ownerId, deviceId } : null),
    transaction: <Result>(id: string, work: (scope: DeviceSocketScope) => Promise<Result>) => {
      assert.equal(id, ownerId);
      return work({ deviceSessions: sessions, deviceExecutions: rejectedEvidence });
    },
  });
  const host = startServer(
    { hostname: "127.0.0.1", port: 0, shutdownTimeoutMs: 1000 },
    { deviceTransport: transport },
  );
  const base = `http://127.0.0.1:${String(host.server.port)}`;
  const clients: WebSocket[] = [];
  async function connect() {
    const socket = new WebSocket(`${base.replace("http:", "ws:")}/api/devices/socket`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    clients.push(socket);
    const welcome = JSON.parse(await received(socket)) as Record<string, unknown>;
    assert.equal(welcome.kind, "session");
    assert.equal(welcome.version, 1);
    const session = deviceSessionSchema.parse({
      deviceId: welcome.deviceId,
      sessionId: welcome.sessionId,
      generation: welcome.generation,
      expiresAt: welcome.expiresAt,
    });
    return { socket, session };
  }
  function frame(session: DeviceSessionIdentity) {
    return encodeDeviceMessage({
      version: 1,
      messageId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      generation: session.generation,
      payload: { kind: "heartbeat", status: "ready" },
    });
  }
  try {
    assert.equal((await fetch(`${base}/api/devices/socket`)).status, 400);
    assert.equal(
      (await fetch(`${base}/api/devices/socket`, { headers: { Upgrade: "websocket" } })).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/api/devices/socket`, {
          headers: { Upgrade: "websocket", Origin: base, Authorization: `Bearer ${credential}` },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/api/devices/socket?token=redacted`, {
          headers: { Upgrade: "websocket", Authorization: `Bearer ${credential}` },
        })
      ).status,
      400,
    );
    assert.equal(generation, 0);
    const first = await connect();
    const acknowledgment = received(first.socket);
    const sent = frame(first.session);
    first.socket.send(sent);
    const reply = decodeDeviceMessage(await acknowledgment);
    assert.equal(reply.correlationId, decodeDeviceMessage(sent).messageId);
    assert.equal(reply.payload.kind, "heartbeat");
    assert.equal(heartbeats, 1);
    const second = await connect();
    const staleClosed = disconnected(first.socket);
    first.socket.send(frame(first.session));
    await staleClosed;
    const invalidClosed = disconnected(second.socket);
    second.socket.send(frame(first.session));
    await invalidClosed;
    assert.equal(heartbeats, 2);
    const binary = await connect();
    const binaryClosed = disconnected(binary.socket);
    binary.socket.send(new Uint8Array([1, 2, 3]));
    await binaryClosed;
    const active = await connect();
    const stopped = disconnected(active.socket);
    await transport.stop();
    await stopped;
    assert.equal(closed, 4);
  } finally {
    for (const client of clients) client.close();
    await host.stop();
  }
});
