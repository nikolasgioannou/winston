import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import {
  decodeDeviceMessage,
  encodeDeviceMessage,
  type DeviceMessage,
} from "@winston/contracts/devices";

const id = "11111111-1111-4111-8111-111111111111";
const binding = { executionId: id, taskId: id, taskRevision: 1 };

test.skipIf(process.platform !== "darwin")(
  "native commands stream journal-backed results while cancellation, queries and heartbeats remain responsive",
  async () => {
    for (const mode of [
      "complete",
      "duplicate",
      "cancel",
      "disconnect",
      "paused",
      "uncertain",
      "repaired",
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "winston-command-session-"));
      const effect = join(directory, "effects");
      const session = { deviceId: id, sessionId: crypto.randomUUID(), generation: 1 };
      const operation = {
        kind: "command" as const,
        executable: "/bin/sh",
        arguments: [
          "-c",
          mode === "cancel" || mode === "disconnect"
            ? 'printf "once\\n" >> "$1"; printf ready; exec /bin/sleep 30'
            : 'printf "once\\n" >> "$1"; printf "hello 😀"; printf problem >&2',
          "fixture",
          effect,
        ],
        directory,
      };
      const envelope = (payload: DeviceMessage["payload"]): DeviceMessage => ({
        version: 1,
        ...session,
        messageId: crypto.randomUUID(),
        correlationId: id,
        payload,
      });
      const execute = envelope({
        kind: "execute",
        ...binding,
        deadline: Date.now() + 20_000,
        operation,
      });
      const query = envelope({ kind: "reconcile", ...binding, operation });
      await writeFile(
        join(directory, "request.json"),
        JSON.stringify(
          mode === "repaired" ? { ...execute, deviceId: crypto.randomUUID() } : execute,
        ),
      );
      const failures: unknown[] = [];
      let stdout = "";
      let stderr = "";
      let sequence = -1;
      let terminal = 0;
      let heartbeats = 0;
      let queried = false;
      let cancelReady = false;
      let canceled = false;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, host) {
          if (request.headers.get("Authorization") !== `Bearer wdi_${"a".repeat(43)}`)
            return new Response(null, { status: 401 });
          if (host.upgrade(request)) return;
          return new Response(null, { status: 400 });
        },
        websocket: {
          open(socket) {
            socket.send(
              JSON.stringify({
                kind: "session",
                version: 1,
                ...session,
                expiresAt: new Date(Date.now() + 45_000).toISOString(),
              }),
            );
          },
          message(socket, raw) {
            try {
              if (typeof raw !== "string") throw new Error("Expected native text frame");
              const message = decodeDeviceMessage(raw);
              assert.equal(message.sessionId, session.sessionId);
              const payload = message.payload;
              if (payload.kind === "heartbeat") {
                heartbeats += 1;
                socket.send(
                  encodeDeviceMessage({
                    ...message,
                    messageId: crypto.randomUUID(),
                    correlationId: message.messageId,
                  }),
                );
              } else if (payload.kind === "capabilities") {
                const blocked = mode === "uncertain" || mode === "repaired";
                assert.deepEqual(payload.capabilities, blocked ? [] : ["command"]);
                socket.send(encodeDeviceMessage(blocked ? query : execute));
              } else if (payload.kind === "reconciled") {
                assert.equal(message.correlationId, query.messageId);
                assert.equal(
                  payload.state,
                  mode === "duplicate"
                    ? "succeeded"
                    : mode === "uncertain"
                      ? "uncertain"
                      : mode === "repaired"
                        ? "missing"
                        : "running",
                );
                queried = true;
                if (mode === "uncertain" || mode === "repaired") socket.close();
                else if (mode === "duplicate") socket.send(encodeDeviceMessage(execute));
                else cancelReady = true;
              } else if (payload.kind === "status" || payload.kind === "output") {
                assert.equal(message.correlationId, execute.messageId);
                assert.equal(payload.executionId, id);
                assert.equal(payload.taskId, id);
                if (!(mode === "duplicate" && terminal === 1))
                  assert.ok(payload.sequence > sequence);
                sequence = payload.sequence;
                if (payload.kind === "output") {
                  if (payload.stream === "stdout") stdout += payload.text;
                  else stderr += payload.text;
                  if (stdout.includes("ready")) {
                    if (mode === "disconnect") socket.close();
                    else if (mode === "cancel" && !queried) {
                      socket.send(
                        encodeDeviceMessage(
                          envelope({ ...binding, kind: "cancel", taskId: crypto.randomUUID() }),
                        ),
                      );
                      socket.send(encodeDeviceMessage(query));
                    }
                  }
                } else if (["succeeded", "failed", "canceled"].includes(payload.state)) {
                  terminal += 1;
                  assert.equal(payload.state, mode === "cancel" ? "canceled" : "succeeded");
                  if (mode === "duplicate" && terminal === 1)
                    socket.send(encodeDeviceMessage(query));
                  else socket.close();
                }
              } else assert.fail("Unexpected native payload");
              if (cancelReady && heartbeats >= 2 && !canceled) {
                canceled = true;
                socket.send(encodeDeviceMessage(envelope({ kind: "cancel", ...binding })));
              }
            } catch (error) {
              failures.push(error);
              socket.close();
            }
          },
        },
      });
      const child = Bun.spawn(
        [
          "xcrun",
          "swift",
          "run",
          "--package-path",
          "apps/desktop-macos",
          "CommandSessionFixture",
          `ws://127.0.0.1:${String(server.port)}/api/devices/socket`,
          directory,
          mode,
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timeout = setTimeout(() => {
        child.kill();
      }, 30_000);
      try {
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assert.deepEqual(failures, [], mode);
        assert.equal(code, 0, `${mode}: ${error}`);
        assert.match(output, /Native command session checks passed/);
        if (mode === "paused" || mode === "uncertain" || mode === "repaired")
          await assert.rejects(() => readFile(effect), { code: "ENOENT" });
        else assert.equal(await readFile(effect, "utf8"), "once\n");
        if (mode === "complete" || mode === "duplicate") {
          assert.equal(stdout, "hello 😀");
          assert.equal(stderr, "problem");
          assert.equal(terminal, mode === "duplicate" ? 2 : 1);
        }
        if (mode === "cancel") {
          assert.equal(queried, true);
          assert.equal(canceled, true);
          assert.equal(terminal, 1);
          assert.ok(heartbeats >= 2);
        }
      } finally {
        clearTimeout(timeout);
        child.kill();
        await child.exited;
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  90_000,
);
