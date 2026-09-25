import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { cliDeviceResultSchema, type CliAuthority, type CliRequest } from "@winston/contracts/cli";
import { callDeviceCommand } from "../../../../apps/cli/src/device-command";
import { callGateway } from "../../../../apps/cli/src/gateway";
import { createDeviceCli } from "../../../../apps/server/src/devices/cli";
import { createDeviceSocketTransport } from "../../../../apps/server/src/devices/socket";
import { createCliTaskGroup } from "../../../../apps/server/src/http/cli";
import { startServer } from "../../../../apps/server/src/host";
import { withTestPostgres } from "../../src/postgres";

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Native integration condition timed out");
    await sleep(25);
  }
}

test.skipIf(process.platform !== "darwin")(
  "native commands complete and cancel through the authenticated HTTP CLI and durable socket",
  async () => {
    await withTestPostgres(async (_sql, connectionString) => {
      await migrateDatabase(connectionString);
      const database = createDatabase({ connectionString, onConnectionError: () => {} });
      const directory = await mkdtemp(join(tmpdir(), "winston-native-cli-"));
      const transport = createDeviceSocketTransport(database);
      const devices = createDeviceCli({
        database,
        dispatch: transport.dispatch,
        server: transport.routing,
      });
      const host = startServer(
        { hostname: "127.0.0.1", port: 0, shutdownTimeoutMs: 5000 },
        {
          deviceTransport: transport,
          groups: { task: createCliTaskGroup(database, { devices }) },
        },
      );
      let stopChild: (() => Promise<void>) | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const ownerId = randomUUID();
        const workspaceId = randomUUID();
        const setup = await database.transaction(ownerId, async (scope) => {
          await scope.owners.ensure();
          await scope.workspaces.register(workspaceId, "Native integration");
          await scope.workspaces.setState(workspaceId, 0, "active");
          const queued = await scope.tasks.create({
            key: randomUUID(),
            objective: "Disposable native commands",
            sourceMessageIds: [],
          });
          const worker = await scope.tasks.claim(queued.id, queued.revision);
          const challenge = await scope.devices.start("Disposable computer");
          const pair = await scope.devices.pair(challenge.secret, {
            platform: "macos",
            appVersion: "0.1.0",
            protocolVersion: 1,
            capabilities: ["command"],
          });
          assert.ok(pair);
          await scope.authorization.put({
            target: { kind: "device", id: pair.device.id, resource: null },
            operation: "device.command",
            decision: "allow",
            revision: 0,
          });
          const issue = (operation: "gateway:read" | "gateway:control") =>
            scope.capabilities.issue(
              {
                kind: "workspace",
                subjectId: workspaceId,
                resourceId: workspaceId,
                resourceRevision: 1,
                taskId: worker.id,
                revision: worker.revision,
                generation: worker.generation,
                operation,
                credential: null,
              },
              300,
            );
          const read = await issue("gateway:read");
          const control = await issue("gateway:control");
          return { pair, worker, read, control };
        });
        await writeFile(
          join(directory, "identity.json"),
          JSON.stringify({ deviceId: setup.pair.device.id, credential: setup.pair.credential }),
          { mode: 0o600 },
        );
        const process = Bun.spawn(
          [
            "xcrun",
            "swift",
            "run",
            "--package-path",
            "apps/desktop-macos",
            "CommandSessionFixture",
            `ws://127.0.0.1:${String(host.server.port)}/api/devices/socket`,
            directory,
            "integrated",
          ],
          {
            cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        stopChild = async () => {
          process.kill();
          await process.exited;
        };
        timeout = setTimeout(() => {
          process.kill();
        }, 45_000);
        const stdout = new Response(process.stdout).text();
        const stderr = new Response(process.stderr).text();
        await until(async () =>
          database.transaction(ownerId, async ({ deviceSessions }) => {
            const route = await deviceSessions.route(setup.pair.device.id);
            return (
              route !== null &&
              (await deviceSessions.supports(
                {
                  deviceId: route.deviceId,
                  sessionId: route.sessionId,
                  generation: route.generation,
                },
                "command",
              ))
            );
          }),
        );
        const authority: CliAuthority = {
          version: 1,
          workspaceId,
          token: setup.read.token,
          controlToken: setup.control.token,
          environment: "local",
          expiresAt: new Date(Date.now() + 240_000).toISOString(),
        };
        const call = (grant: CliAuthority, request: CliRequest) =>
          callGateway(grant, request, (url, init) => {
            const target = new URL(url);
            target.port = String(host.server.port);
            return fetch(target, init);
          });
        const effects = join(directory, "effects");
        const request = {
          version: 1 as const,
          command: "devices.command" as const,
          id: setup.pair.device.id,
          key: "literal",
          operation: {
            kind: "command" as const,
            executable: "/bin/sh",
            arguments: [
              "-c",
              'printf "%s\\n" "$1"; printf "once\\n" >> "$2"',
              "fixture",
              "literal; $(not expanded) 😀",
              effects,
            ],
            directory,
          },
        };
        const result = await callDeviceCommand(authority, request, { call, wait: () => sleep(25) });
        assert.equal(result.status, "ok");
        const receipt = cliDeviceResultSchema.parse(result.data);
        assert.equal(receipt.state, "succeeded");
        assert.equal(receipt.exitCode, 0);
        assert.equal(
          receipt.output.map((chunk) => chunk.text).join(""),
          "literal; $(not expanded) 😀\n",
        );
        const duplicate = await callDeviceCommand(authority, request, { call });
        assert.equal(duplicate.status, "ok");
        assert.equal(cliDeviceResultSchema.parse(duplicate.data).executionId, receipt.executionId);
        assert.equal(await readFile(effects, "utf8"), "once\n");
        const marker = join(directory, "started");
        const longRequest = {
          ...request,
          key: "cancel",
          operation: {
            kind: "command" as const,
            executable: "/bin/sh",
            arguments: ["-c", 'printf started > "$1"; exec /bin/sleep 30', "fixture", marker],
            directory,
          },
        };
        const running = await call(authority, longRequest);
        assert.equal(running.status, "ok");
        const runningId = cliDeviceResultSchema.parse(running.data).id;
        await until(async () => (await readFile(marker, "utf8").catch(() => "")) === "started");
        const cancellation = await call(authority, {
          version: 1,
          command: "operations.cancel",
          id: runningId,
        });
        assert.equal(cancellation.status, "waiting");
        await transport.maintain(ownerId);
        await until(async () => {
          const current = await call(authority, {
            version: 1,
            command: "devices.result",
            id: runningId,
            after: -1,
          });
          return (
            current.status === "ok" &&
            cliDeviceResultSchema.parse(current.data).state === "canceled"
          );
        });
        await host.stop();
        assert.equal(await process.exited, 0, await stderr);
        assert.match(await stdout, /Native command session checks passed/);
      } finally {
        clearTimeout(timeout);
        await host.stop();
        await stopChild?.();
        await database.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
  90_000,
);
