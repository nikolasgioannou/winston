import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import type { OwnerTransaction } from "@winston/adapters/database";
import { createDeviceSocketTransport } from "../src/devices/socket";
import { startServer } from "../src/host";
import { decodeDeviceMessage } from "@winston/contracts/devices";

async function runFixture(port: number | undefined, mode?: string) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const child = Bun.spawn(
    [
      "xcrun",
      "swift",
      "run",
      "--package-path",
      "packages/device-transport",
      "TransportFixture",
      `ws://127.0.0.1:${String(port)}/api/devices/socket`,
      ...(mode ? [mode] : []),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, stderr);
    assert.match(
      stdout,
      mode === "reconnect" || mode === "pairing"
        ? /Native connection lifecycle passed/
        : mode
          ? /Native transport rejected connection/
          : /Native transport handshake and heartbeat passed/,
    );
  } finally {
    child.kill();
  }
}

test.skipIf(process.platform !== "darwin")(
  "Foundation client exchanges a real authenticated heartbeat with Bun",
  async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    let heartbeats = 0;
    const deviceSessions: OwnerTransaction["deviceSessions"] = {
      advertise: () => Promise.resolve(true),
      supports: () => Promise.resolve(false),
      open: () =>
        Promise.resolve({
          deviceId: id,
          sessionId: id,
          generation: 1,
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        }),
      heartbeat: (session, status) => {
        assert.equal(session.deviceId, id);
        assert.equal(session.generation, 1);
        assert.equal(status, "paused");
        heartbeats += 1;
        return Promise.resolve(true);
      },
      close: () => Promise.resolve(true),
      expire: () => Promise.resolve(0),
      presence: () => Promise.resolve([]),
    };
    const transport = createDeviceSocketTransport({
      authenticateDevice: (credential) =>
        Promise.resolve(
          credential === `wdi_${"a".repeat(43)}` ? { ownerId: id, deviceId: id } : null,
        ),
      transaction: <Result>(
        _id: string,
        work: (scope: Pick<OwnerTransaction, "deviceSessions">) => Promise<Result>,
      ) => work({ deviceSessions }),
    });
    const host = startServer(
      { hostname: "127.0.0.1", port: 0, shutdownTimeoutMs: 1000 },
      { deviceTransport: transport },
    );
    try {
      await runFixture(host.server.port);
      assert.equal(heartbeats, 1);
    } finally {
      await host.stop();
    }
  },
  60_000,
);

test.skipIf(process.platform !== "darwin")(
  "native loop reconnects with a new session and stops after credential rejection",
  async () => {
    let rejected = false;
    let requests = 0;
    let connections = 0;
    let heartbeats = 0;
    const id = "11111111-1111-4111-8111-111111111111";
    const server = Bun.serve<{ sessionId: string; generation: number }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, host) {
        requests += 1;
        if (rejected) return new Response(null, { status: 401 });
        connections += 1;
        if (
          host.upgrade(request, {
            data: { sessionId: crypto.randomUUID(), generation: connections },
          })
        )
          return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          socket.send(
            JSON.stringify({
              kind: "session",
              version: 1,
              deviceId: id,
              ...socket.data,
              expiresAt: new Date(Date.now() + 45_000).toISOString(),
            }),
          );
        },
        message(socket, raw) {
          const message = decodeDeviceMessage(String(raw));
          assert.equal(message.sessionId, socket.data.sessionId);
          assert.equal(message.generation, socket.data.generation);
          heartbeats += 1;
          if (socket.data.generation === 1) socket.close(1001);
          else
            socket.send(
              JSON.stringify({
                ...message,
                messageId: crypto.randomUUID(),
                correlationId: message.messageId,
              }),
            );
        },
      },
    });
    try {
      await runFixture(server.port, "reconnect");
      assert.equal(connections, 2);
      assert.equal(heartbeats, 2);
      rejected = true;
      const before = requests;
      await runFixture(server.port, "pairing");
      assert.equal(requests - before, 1);
    } finally {
      await server.stop(true);
    }
  },
  60_000,
);

test.skipIf(process.platform !== "darwin")(
  "Foundation rejects redirects, invalid bindings and revoked credentials and cancels stalled reads",
  async () => {
    let mode = "redirect";
    let redirected = 0;
    const id = "11111111-1111-4111-8111-111111111111";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, host) {
        if (new URL(request.url).pathname === "/redirected") {
          redirected += 1;
          return new Response(null, { status: 401 });
        }
        if (mode === "redirect")
          return new Response(null, { status: 302, headers: { Location: "/redirected" } });
        if (mode === "revoked") return new Response(null, { status: 401 });
        if (host.upgrade(request)) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          if (mode === "cancel") return;
          socket.send(
            JSON.stringify({
              kind: "session",
              version: 1,
              deviceId: mode === "wrong-device" ? crypto.randomUUID() : id,
              sessionId: id,
              generation: 1,
              expiresAt: new Date().toISOString(),
            }),
          );
        },
        message(socket, raw) {
          assert.equal(typeof raw, "string");
          const message = decodeDeviceMessage(String(raw));
          socket.send(JSON.stringify({ ...message, correlationId: crypto.randomUUID() }));
        },
      },
    });
    try {
      for (const value of ["redirect", "revoked", "wrong-device", "wrong-ack", "cancel"]) {
        mode = value;
        await runFixture(server.port, value);
      }
      assert.equal(redirected, 0);
    } finally {
      await server.stop(true);
    }
  },
  60_000,
);
