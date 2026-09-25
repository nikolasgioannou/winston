import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import {
  cliResultSchema,
  cliDeviceResultSchema,
  type CliDeviceRequest,
} from "@winston/contracts/cli";
import { decodeDeviceMessage, type DeviceMessage } from "@winston/contracts/devices";
import { createDeviceCli } from "../../../../apps/server/src/devices/cli";
import { createDeviceDispatcher } from "../../../../apps/server/src/devices/dispatch";
import { withTestPostgres } from "../../src/postgres";
import { deviceWriteFixture } from "./device-write-fixture";

test("native write CLI preserves approved source and destination and never repeats uncertain effects", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      let port = 11300;
      for (const mode of ["complete", "uncertain", "deleted", "source-policy"] as const) {
        const server = { serverId: randomUUID(), machineId: null };
        const f = await deviceWriteFixture(
          database,
          ++port,
          "workspace",
          Buffer.from("write fixture"),
          server,
        );
        const other = await f.anotherArtifact();
        let worker = f.worker;
        const issue = (operation: "gateway:read" | "gateway:control") =>
          database.transaction(f.ownerId, async ({ capabilities }) => {
            const grant = await capabilities.issue(
              {
                kind: "workspace",
                subjectId: f.workspaceId,
                resourceId: f.workspaceId,
                resourceRevision: 2,
                taskId: worker.id,
                revision: worker.revision,
                generation: worker.generation,
                operation,
                credential: null,
              },
              300,
            );
            return {
              token: grant.token,
              kind: "workspace" as const,
              subjectId: f.workspaceId,
              resourceId: f.workspaceId,
              operation,
            };
          });
        let control = await issue("gateway:control");
        let read = await issue("gateway:read");
        const sent: DeviceMessage[] = [];
        const dispatch = createDeviceDispatcher(database, {
          serverId: server.serverId,
          channel: () => ({
            isOpen: () => true,
            send: (frame) => {
              sent.push(decodeDeviceMessage(frame));
              if (mode === "uncertain") throw new Error("Fixture acknowledgment lost");
              return 1;
            },
            close: () => {},
          }),
        });
        const gateway = createDeviceCli({ database, dispatch, server });
        const request: Extract<CliDeviceRequest, { command: "devices.write" }> = {
          ...f.request,
          command: "devices.write",
          key: "cli-write",
        };
        const call = async (
          input: CliDeviceRequest,
          credential = input.command === "devices.result" ? read : control,
        ) =>
          cliResultSchema.parse(
            await (
              await gateway(credential, input, new Headers(), new AbortController().signal)
            ).json(),
          );
        assert.equal((await call(request, read)).status, "denied");
        const pending = await call(request);
        assert.equal(pending.status, "approval_required");
        assert.ok(pending.referenceId);
        const actionId = pending.referenceId;
        const original = await database.transaction(f.ownerId, ({ actions }) =>
          actions.find(actionId),
        );
        assert.ok(original);
        assert.equal(sent.length, 0);
        worker = await database.transaction(f.ownerId, async ({ actions, tasks }) => {
          const waiting = await tasks.find(worker.id);
          assert.ok(waiting);
          await actions.decide({
            id: original.id,
            revision: original.revision,
            hash: original.hash,
            approve: true,
          });
          const queued = await tasks.resume(waiting.id, waiting.revision, original.id);
          const running = await tasks.claim(queued.id, queued.revision);
          return { id: running.id, revision: running.revision, generation: running.generation };
        });
        control = await issue("gateway:control");
        read = await issue("gateway:read");
        for (const change of [
          { path: "/fixtures/other.txt" },
          { overwrite: true },
          { artifactId: other.id, revision: other.revision },
          { id: randomUUID() },
        ])
          assert.equal((await call({ ...request, ...change })).status, "invalid_input");
        assert.equal(sent.length, 0);
        if (mode === "deleted")
          await database.transaction(f.ownerId, ({ artifacts }) =>
            artifacts.beginDelete(f.artifact.id, f.artifact.revision),
          );
        if (mode === "source-policy")
          await database.transaction(f.ownerId, async ({ authorization }) => {
            const policy = await authorization.list();
            assert.ok(
              await authorization.put({
                target: { kind: "workspace", id: f.workspaceId, resource: null },
                operation: "workspace.file.read",
                decision: "deny",
                revision: policy.revision,
              }),
            );
          });
        const started = await call(request);
        if (mode === "deleted" || mode === "source-policy") {
          assert.equal(started.status, "unavailable");
          assert.equal(sent.length, 0);
          continue;
        }
        assert.equal(sent.length, 1);
        const message = sent[0];
        assert.ok(message && message.payload.kind === "execute");
        assert.deepEqual(message.payload.operation, original.request.arguments);
        assert.equal(message.deviceId, f.session.deviceId);
        if (mode === "uncertain") {
          assert.equal(started.status, "unknown");
          const again = await call(request);
          assert.equal(again.status, "ok");
          assert.equal(cliDeviceResultSchema.parse(again.data).state, "dispatching");
          assert.equal(sent.length, 1);
          continue;
        }
        assert.equal(started.status, "ok");
        assert.equal(cliDeviceResultSchema.parse(started.data).id, actionId);
        const execution = message.payload;
        await database.transaction(f.ownerId, ({ deviceExecutions }) =>
          deviceExecutions.receipt({
            ...message,
            messageId: randomUUID(),
            correlationId: message.messageId,
            payload: {
              kind: "status",
              executionId: execution.executionId,
              taskId: execution.taskId,
              taskRevision: execution.taskRevision,
              sequence: 0,
              state: "succeeded",
              exitCode: 0,
            },
          }),
        );
        const finished = await call({
          version: 1,
          command: "devices.result",
          id: actionId,
          after: -1,
        });
        assert.equal(finished.status, "ok");
        assert.equal(cliDeviceResultSchema.parse(finished.data).state, "succeeded");
        assert.equal((await call(request)).status, "ok");
        assert.equal(sent.length, 1);
        await database.transaction(f.ownerId, async ({ authorization }) => {
          const policy = await authorization.list();
          assert.ok(
            await authorization.put({
              target: { kind: "device", id: f.session.deviceId, resource: null },
              operation: "device.file.write",
              decision: "deny",
              revision: policy.revision,
            }),
          );
        });
        assert.equal(
          (await call({ version: 1, command: "devices.result", id: actionId, after: -1 })).status,
          "denied",
        );
      }
    } finally {
      await database.close();
    }
  });
}, 120_000);
