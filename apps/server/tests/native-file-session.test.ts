import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import {
  decodeDeviceMessage,
  encodeDeviceMessage,
  type DeviceMessage,
} from "@winston/contracts/devices";
import { deviceFileUploadSchema } from "@winston/contracts/artifacts";

const id = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const commandId = "33333333-3333-4333-8333-333333333333";

test.skipIf(process.platform !== "darwin")(
  "native file sessions journal completed reads and preserve uncertainty while joining concurrent workers",
  async () => {
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
    const build = Bun.spawn(
      [
        "xcrun",
        "swift",
        "build",
        "--package-path",
        "apps/desktop-macos",
        "--product",
        "FileSessionFixture",
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const [buildCode, buildOutput, buildError] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    assert.equal(buildCode, 0, buildOutput + buildError);
    for (const mode of [
      "complete",
      "duplicate",
      "missing",
      "denied",
      "unknown",
      "cancel",
      "disconnect",
      "active-duplicate",
      "parallel",
      "restart",
    ]) {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "winston-file-session-")));
      const content = Buffer.alloc(180_000, 42);
      if (mode !== "missing") await writeFile(join(directory, "source"), content);
      const session = {
        deviceId: id,
        sessionId: crypto.randomUUID(),
        generation: mode === "restart" ? 2 : 1,
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
        executionId: id,
        taskId: id,
        taskRevision: 1,
        deadline: Date.now() + 20_000,
        operation: {
          kind: "file.read",
          path: join(directory, "source"),
          transferId: crypto.randomUUID(),
        },
      });
      assert.equal(execute.payload.kind, "execute");
      if (mode === "restart")
        await writeFile(
          join(directory, "request.json"),
          JSON.stringify({ ...execute, sessionId: crypto.randomUUID(), generation: 1 }),
        );
      const query = envelope({
        kind: "reconcile",
        executionId: id,
        taskId: id,
        taskRevision: 1,
        operation: execute.payload.operation,
      });
      const errors: unknown[] = [];
      const pending: (() => void)[] = [];
      const peer: { send?: (message: DeviceMessage) => void; close?: () => void } = {};
      let uploads = 0;
      let terminals = 0;
      const progress = { queried: false, commandOutput: false };
      let heartbeats = 0;
      const release = () => {
        if (uploads === 2 && progress.queried && progress.commandOutput) {
          for (const resolve of pending.splice(0)) resolve();
        }
      };
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request, host) {
          if (request.headers.get("Authorization") !== `Bearer wdi_${"a".repeat(43)}`)
            return new Response(null, { status: 401 });
          if (new URL(request.url).pathname === "/api/devices/socket") {
            if (host.upgrade(request)) return;
            return new Response(null, { status: 400 });
          }
          try {
            assert.equal(new URL(request.url).pathname, "/api/devices/files/upload");
            const descriptor = deviceFileUploadSchema.parse(
              JSON.parse(
                Buffer.from(request.headers.get("X-Winston-File") ?? "", "base64url").toString(
                  "utf8",
                ),
              ),
            );
            assert.deepEqual(descriptor.authority.session, session);
            assert.deepEqual(Buffer.from(await request.arrayBuffer()), content);
            assert.equal(descriptor.sha256, createHash("sha256").update(content).digest("hex"));
            uploads += 1;
            assert.ok(peer.send);
            assert.ok(peer.close);
            if (mode === "parallel") {
              const waiting = new Promise<void>((resolve) => {
                pending.push(resolve);
              });
              if (uploads === 2) peer.send(query);
              release();
              await waiting;
            }
            if (mode === "cancel" || mode === "disconnect" || mode === "active-duplicate") {
              if (mode === "cancel")
                peer.send(
                  envelope({ kind: "cancel", executionId: id, taskId: id, taskRevision: 1 }),
                );
              else if (mode === "active-duplicate") peer.send(execute);
              else peer.close();
              return new Response(new ReadableStream(), {
                headers: { "Content-Type": "application/json" },
              });
            }
            if (mode === "denied" || mode === "unknown")
              return Response.json({
                version: 1,
                status: mode,
                transferId: descriptor.authority.transferId,
              });
            return Response.json({
              version: 1,
              status: "ready",
              transferId: descriptor.authority.transferId,
              artifactId: crypto.randomUUID(),
              revision: 1,
              size: descriptor.size,
              sha256: descriptor.sha256,
            });
          } catch (error) {
            errors.push(error);
            return new Response(null, { status: 500 });
          }
        },
        websocket: {
          open(socket) {
            peer.send = (message) => {
              socket.send(encodeDeviceMessage(message));
            };
            peer.close = () => {
              socket.close();
            };
            socket.send(
              JSON.stringify({
                version: 1,
                kind: "session",
                ...session,
                expiresAt: new Date(Date.now() + 45_000).toISOString(),
              }),
            );
          },
          message(socket, raw) {
            try {
              assert.ok(typeof raw === "string");
              const message = decodeDeviceMessage(raw);
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
                if (mode === "restart") {
                  assert.deepEqual(payload.capabilities, []);
                  socket.send(encodeDeviceMessage(query));
                  return;
                }
                assert.deepEqual(payload.capabilities, ["command", "file.read"]);
                socket.send(encodeDeviceMessage(execute));
                if (mode === "parallel") {
                  assert.equal(execute.payload.kind, "execute");
                  assert.equal(execute.payload.operation.kind, "file.read");
                  socket.send(
                    encodeDeviceMessage(
                      envelope({
                        ...execute.payload,
                        executionId: second,
                        operation: {
                          ...execute.payload.operation,
                          transferId: crypto.randomUUID(),
                        },
                      }),
                    ),
                  );
                  socket.send(
                    encodeDeviceMessage(
                      envelope({
                        kind: "execute",
                        executionId: commandId,
                        taskId: id,
                        taskRevision: 1,
                        deadline: Date.now() + 20_000,
                        operation: {
                          kind: "command",
                          executable: "/bin/echo",
                          arguments: ["parallel"],
                          directory,
                        },
                      }),
                    ),
                  );
                }
              } else if (payload.kind === "output") {
                assert.equal(payload.executionId, commandId);
                progress.commandOutput = true;
                release();
              } else if (payload.kind === "reconciled") {
                assert.equal(
                  payload.state,
                  mode === "duplicate" ? "succeeded" : mode === "restart" ? "uncertain" : "running",
                );
                if (mode === "restart") socket.close();
                progress.queried = true;
                if (mode === "duplicate") socket.send(encodeDeviceMessage(execute));
                release();
              } else if (
                payload.kind === "status" &&
                ["succeeded", "failed", "canceled"].includes(payload.state)
              ) {
                terminals += 1;
                assert.equal(
                  payload.state,
                  mode === "missing" || mode === "denied" ? "failed" : "succeeded",
                );
                if (mode === "duplicate" && terminals === 1)
                  socket.send(encodeDeviceMessage(query));
                else if (terminals === (mode === "parallel" ? 3 : mode === "duplicate" ? 2 : 1))
                  socket.close();
              }
            } catch (error) {
              errors.push(error);
              socket.close();
            }
          },
        },
      });
      const child = Bun.spawn(
        [
          "apps/desktop-macos/.build/debug/FileSessionFixture",
          `ws://127.0.0.1:${String(server.port)}/api/devices/socket`,
          directory,
          mode,
        ],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => {
        child.kill();
      }, 15_000);
      try {
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assert.deepEqual(errors, [], mode);
        assert.equal(code, 0, `${mode}: ${error}`);
        assert.match(output, /Native file session checks passed/);
        assert.equal(
          uploads,
          mode === "missing" || mode === "restart" ? 0 : mode === "parallel" ? 2 : 1,
          mode,
        );
        assert.ok(heartbeats >= 1, mode);
        if (["unknown", "cancel", "disconnect", "active-duplicate", "restart"].includes(mode))
          assert.equal(terminals, 0);
        if (mode === "parallel") assert.ok(progress.queried && progress.commandOutput);
      } finally {
        clearTimeout(timer);
        child.kill();
        await child.exited;
        for (const resolve of pending.splice(0)) resolve();
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  180_000,
);
