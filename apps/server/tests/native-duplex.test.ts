import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { decodeDeviceMessage, type DeviceMessage } from "@winston/contracts/devices";

const id = "11111111-1111-4111-8111-111111111111";
const binding = { executionId: id, taskId: id, taskRevision: 1 };

async function runFixture(port: number | undefined, mode: string) {
  const child = Bun.spawn(
    [
      "xcrun",
      "swift",
      "run",
      "--package-path",
      "packages/device-transport",
      "DuplexFixture",
      `ws://127.0.0.1:${String(port)}/api/devices/socket`,
      mode,
    ],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => {
    child.kill();
  }, 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Native duplex transport passed/);
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

test.skipIf(process.platform !== "darwin")(
  "native channel receives independently, preserves ordering and fences disconnected sessions",
  async () => {
    for (const mode of [
      "duplex",
      "idle",
      "overflow",
      "wrong-generation",
      "wrong-session",
      "wrong-device",
      "wrong-direction",
      "binary",
      "disconnect",
      "cancel-heartbeat",
      "replace",
      "heartbeat-timeout",
      "cancel-observer",
    ]) {
      let connections = 0;
      let heartbeats = 0;
      const results: DeviceMessage[] = [];
      const failures: unknown[] = [];
      const message = (
        sessionId: string,
        generation: number,
        payload: DeviceMessage["payload"],
      ) => ({
        version: 1,
        messageId: crypto.randomUUID(),
        correlationId: id,
        deviceId: id,
        sessionId,
        generation,
        payload,
      });
      const execute = (sessionId: string, generation: number) =>
        message(sessionId, generation, {
          kind: "execute",
          ...binding,
          deadline: Date.now() + 60_000,
          operation: {
            kind: "command",
            executable: "/usr/bin/true",
            arguments: [],
            directory: "/tmp",
          },
        });
      const server = Bun.serve<{ sessionId: string; generation: number; executeId: string }>({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, host) {
          connections += 1;
          if (
            host.upgrade(request, {
              data: { sessionId: crypto.randomUUID(), generation: connections, executeId: "" },
            })
          )
            return;
          return new Response(null, { status: 400 });
        },
        websocket: {
          open(socket) {
            const { sessionId, generation } = socket.data;
            socket.send(
              JSON.stringify({
                kind: "session",
                version: 1,
                deviceId: id,
                sessionId,
                generation,
                expiresAt: new Date(Date.now() + 45_000).toISOString(),
              }),
            );
            if (
              [
                "duplex",
                "disconnect",
                "cancel-heartbeat",
                "replace",
                "heartbeat-timeout",
                "cancel-observer",
              ].includes(mode)
            )
              return;
            const first = execute(sessionId, generation);
            socket.data.executeId = first.messageId;
            if (mode === "idle") {
              socket.send(JSON.stringify(first));
              socket.send(
                JSON.stringify(message(sessionId, generation, { kind: "cancel", ...binding })),
              );
            } else if (mode === "overflow") {
              for (let index = 0; index < 33; index += 1)
                socket.send(JSON.stringify(execute(sessionId, generation)));
            } else if (mode === "binary") socket.send(new Uint8Array([1, 2, 3]));
            else if (mode === "wrong-direction")
              socket.send(
                JSON.stringify(
                  message(sessionId, generation, { kind: "capabilities", capabilities: [] }),
                ),
              );
            else
              socket.send(
                JSON.stringify({
                  ...first,
                  ...(mode === "wrong-generation" ? { generation: generation + 1 } : {}),
                  ...(mode === "wrong-session" ? { sessionId: crypto.randomUUID() } : {}),
                  ...(mode === "wrong-device" ? { deviceId: crypto.randomUUID() } : {}),
                }),
              );
          },
          message(socket, raw) {
            try {
              const incoming = decodeDeviceMessage(String(raw));
              assert.equal(incoming.deviceId, id);
              assert.equal(incoming.sessionId, socket.data.sessionId);
              assert.equal(incoming.generation, socket.data.generation);
              if (incoming.payload.kind === "heartbeat") {
                heartbeats += 1;
                if (mode === "duplex") {
                  const first = execute(socket.data.sessionId, socket.data.generation);
                  socket.data.executeId = first.messageId;
                  socket.send(JSON.stringify(first));
                  socket.send(
                    JSON.stringify(
                      message(socket.data.sessionId, socket.data.generation, {
                        kind: "cancel",
                        ...binding,
                      }),
                    ),
                  );
                }
                if (
                  mode === "duplex" ||
                  mode === "cancel-observer" ||
                  (mode === "replace" && socket.data.generation === 2)
                ) {
                  socket.send(
                    JSON.stringify({
                      ...incoming,
                      messageId: crypto.randomUUID(),
                      correlationId: incoming.messageId,
                    }),
                  );
                }
              } else {
                assert.equal(incoming.correlationId, socket.data.executeId);
                results.push(incoming);
                if (results.length === 2) socket.close(1000);
              }
            } catch (error) {
              failures.push(error);
              socket.close(1002);
            }
          },
        },
      });
      try {
        await runFixture(server.port, mode);
        assert.deepEqual(failures, [], mode);
        if (mode === "duplex" || mode === "idle") {
          assert.deepEqual(
            results.map((result) => result.payload),
            [
              { kind: "output", ...binding, sequence: 1, stream: "stdout", text: "fixture" },
              { kind: "status", ...binding, sequence: 2, state: "succeeded", exitCode: 0 },
            ],
          );
          assert.equal(heartbeats, mode === "idle" ? 0 : 1);
        }
        if (mode === "replace") {
          assert.equal(connections, 2);
          assert.equal(heartbeats, 2);
          assert.equal(results.length, 0);
        }
      } finally {
        await server.stop(true);
      }
    }
  },
  120_000,
);
