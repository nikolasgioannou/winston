import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import {
  decodeDeviceMessage,
  encodeDeviceMessage,
  type DeviceMessage,
} from "@winston/contracts/devices";
import { deviceFileDownloadSchema } from "@winston/contracts/device-file-writes";

const id = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const commandId = "33333333-3333-4333-8333-333333333333";

test.skipIf(process.platform !== "darwin")(
  "native write sessions keep durable results and join canceled file workers",
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
        "FileWriteSessionFixture",
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
      "denied",
      "corrupt",
      "cleanup",
      "collision",
      "cancel",
      "disconnect",
      "active-duplicate",
      "parallel",
      "restart",
    ]) {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "winston-write-session-")));
      const content = Buffer.alloc(180_000, 42);
      if (mode === "collision") await writeFile(join(directory, "destination"), "original");
      const source = {
        artifactId: crypto.randomUUID(),
        revision: 2,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
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
          kind: "file.write",
          path: join(directory, "destination"),
          transferId: crypto.randomUUID(),
          overwrite: false,
          source,
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
      let downloads = 0;
      let terminals = 0;
      let heartbeats = 0;
      const progress = { queried: false, commandOutput: false };
      const release = () => {
        if (downloads === 2 && progress.queried && progress.commandOutput)
          for (const resolve of pending.splice(0)) resolve();
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
            assert.equal(new URL(request.url).pathname, "/api/devices/files/download");
            const descriptor = deviceFileDownloadSchema.parse(await request.json());
            assert.deepEqual(descriptor.authority.session, session);
            assert.ok([id, second].includes(descriptor.authority.executionId));
            downloads += 1;
            if (mode === "cleanup") {
              const temporary = join(
                directory,
                `.winston-transfer-${descriptor.authority.transferId}`,
              );
              let ready = false;
              for (let attempt = 0; attempt < 100; attempt += 1) {
                ready = await access(temporary).then(
                  () => true,
                  () => false,
                );
                if (ready) break;
                await sleep(5);
              }
              assert.ok(ready, "Writer created its temporary file before denying cleanup");
              await chmod(directory, 0o500);
            }
            assert.ok(peer.send);
            assert.ok(peer.close);
            if (mode === "parallel") {
              const waiting = new Promise<void>((resolve) => {
                pending.push(resolve);
              });
              if (downloads === 2) peer.send(query);
              release();
              await waiting;
            }
            if (["cancel", "disconnect", "active-duplicate"].includes(mode)) {
              if (mode === "cancel")
                peer.send(
                  envelope({ kind: "cancel", executionId: id, taskId: id, taskRevision: 1 }),
                );
              else if (mode === "active-duplicate") peer.send(execute);
              else peer.close();
              return new Response(new ReadableStream(), {
                headers: {
                  "Content-Type": "application/octet-stream",
                  "X-Winston-File": Buffer.from(JSON.stringify({ version: 1, source })).toString(
                    "base64url",
                  ),
                },
              });
            }
            if (mode === "denied") return new Response(null, { status: 403 });
            return new Response(
              ["corrupt", "cleanup"].includes(mode) ? Buffer.alloc(content.length, 43) : content,
              {
                headers: {
                  "Content-Type": "application/octet-stream",
                  "X-Winston-File": Buffer.from(JSON.stringify({ version: 1, source })).toString(
                    "base64url",
                  ),
                },
              },
            );
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
                assert.deepEqual(payload.capabilities, ["command", "file.write"]);
                socket.send(encodeDeviceMessage(execute));
                if (mode === "parallel") {
                  assert.equal(execute.payload.kind, "execute");
                  assert.equal(execute.payload.operation.kind, "file.write");
                  socket.send(
                    encodeDeviceMessage(
                      envelope({
                        ...execute.payload,
                        executionId: second,
                        operation: {
                          ...execute.payload.operation,
                          path: join(directory, "second"),
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
                  ["denied", "corrupt", "collision"].includes(mode)
                    ? "failed"
                    : mode === "cancel"
                      ? "canceled"
                      : "succeeded",
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
          "apps/desktop-macos/.build/debug/FileWriteSessionFixture",
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
        assert.match(output, /Native file write session checks passed/);
        if (mode === "collision") assert.ok(downloads <= 1);
        else assert.equal(downloads, mode === "restart" ? 0 : mode === "parallel" ? 2 : 1, mode);
        assert.ok(heartbeats >= 1, mode);
        if (["disconnect", "active-duplicate", "restart", "cleanup"].includes(mode))
          assert.equal(terminals, 0);
        if (mode === "parallel") assert.ok(progress.queried && progress.commandOutput);
      } finally {
        clearTimeout(timer);
        child.kill();
        await child.exited;
        for (const resolve of pending.splice(0)) resolve();
        await server.stop(true);
        await chmod(directory, 0o700);
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  180_000,
);
