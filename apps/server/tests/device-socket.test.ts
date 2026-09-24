import assert from "node:assert/strict";
import { test } from "bun:test";
import type { OwnerTransaction } from "@winston/adapters/database";
import {
  deviceSessionSchema,
  type DeviceSessionIdentity,
} from "@winston/contracts/device-registry";
import { decodeDeviceMessage, encodeDeviceMessage } from "@winston/contracts/devices";
import { createDeviceSocketTransport } from "../src/devices/socket";
import { startServer } from "../src/host";

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

test("proxy sockets authenticate, acknowledge fenced heartbeats and close invalid sessions", async () => {
  const ownerId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const credential = `wdi_${"a".repeat(43)}`;
  let generation = 0;
  let heartbeats = 0;
  let closed = 0;
  let current: DeviceSessionIdentity | undefined;
  const sessions: OwnerTransaction["deviceSessions"] = {
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
    transaction: <Result>(
      id: string,
      work: (scope: Pick<OwnerTransaction, "deviceSessions">) => Promise<Result>,
    ) => {
      assert.equal(id, ownerId);
      return work({ deviceSessions: sessions });
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
