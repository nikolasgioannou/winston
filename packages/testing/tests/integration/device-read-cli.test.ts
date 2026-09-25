import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createArtifactService, createDeviceFileReceiver } from "@winston/adapters/artifacts";
import { MissingStoredObject } from "@winston/adapters/storage";
import {
  cliResultSchema,
  cliDeviceResultSchema,
  type CliDeviceRequest,
} from "@winston/contracts/cli";
import {
  decodeDeviceMessage,
  deviceOperationSchema,
  type DeviceMessage,
} from "@winston/contracts/devices";
import { createDeviceCli } from "../../../../apps/server/src/devices/cli";
import { createDeviceDispatcher } from "../../../../apps/server/src/devices/dispatch";
import { withTestPostgres } from "../../src/postgres";

test("device file CLI resumes exact approval and requires native and artifact evidence", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const ownerId = randomUUID();
      const workspaceId = randomUUID();
      const server = { serverId: randomUUID(), machineId: null };
      const setup = await database.transaction(ownerId, async (scope) => {
        await scope.owners.ensure();
        await scope.workspaces.register(workspaceId, "Read fixture");
        await scope.workspaces.setState(workspaceId, 0, "active");
        const queued = await scope.tasks.create({
          key: randomUUID(),
          objective: "Read fixture",
          sourceMessageIds: [],
        });
        const running = await scope.tasks.claim(queued.id, queued.revision);
        const challenge = await scope.devices.start("Fixture Mac");
        const paired = await scope.devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["file.read"],
        });
        assert.ok(paired);
        const opened = await scope.deviceSessions.open(paired.device.id, paired.credential, server);
        assert.ok(opened);
        const session = {
          deviceId: opened.deviceId,
          sessionId: opened.sessionId,
          generation: opened.generation,
        };
        await scope.deviceSessions.advertise(session, ["file.read"]);
        await scope.deviceSessions.heartbeat(session, "ready");
        return {
          worker: { id: running.id, revision: running.revision, generation: running.generation },
          session,
        };
      });
      let worker = setup.worker;
      const issue = async (operation: "gateway:read" | "gateway:control") => {
        const grant = await database.transaction(ownerId, ({ capabilities }) =>
          capabilities.issue(
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
          ),
        );
        return {
          token: grant.token,
          kind: "workspace" as const,
          subjectId: workspaceId,
          resourceId: workspaceId,
          operation,
        };
      };
      const sent: DeviceMessage[] = [];
      const dispatch = createDeviceDispatcher(database, {
        serverId: server.serverId,
        channel: () => ({
          isOpen: () => true,
          send: (frame) => {
            sent.push(decodeDeviceMessage(frame));
            return 1;
          },
          close: () => {},
        }),
      });
      const gateway = createDeviceCli({ database, dispatch, server });
      let control = await issue("gateway:control");
      let read = await issue("gateway:read");
      const request: Extract<CliDeviceRequest, { command: "devices.read" }> = {
        version: 1,
        command: "devices.read",
        id: setup.session.deviceId,
        key: "capture",
        path: "/fixtures/report.txt",
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
      const approval = await call(request);
      assert.equal(approval.status, "approval_required");
      assert.ok(approval.referenceId);
      const id = approval.referenceId;
      const original = await database.transaction(ownerId, ({ actions }) => actions.find(id));
      assert.ok(original);
      const operation = deviceOperationSchema.parse(original.request.arguments);
      assert.equal(operation.kind, "file.read");
      assert.equal(operation.path, request.path);
      assert.equal(sent.length, 0);
      worker = await database.transaction(ownerId, async ({ actions, tasks }) => {
        const waiting = await tasks.find(worker.id);
        assert.ok(waiting);
        await actions.decide({
          id,
          revision: original.revision,
          hash: original.hash,
          approve: true,
        });
        const queued = await tasks.resume(waiting.id, waiting.revision, id);
        const running = await tasks.claim(queued.id, queued.revision);
        return { id: running.id, revision: running.revision, generation: running.generation };
      });
      control = await issue("gateway:control");
      read = await issue("gateway:read");
      const started = await call(request);
      assert.equal(started.status, "ok");
      const pending = cliDeviceResultSchema.parse(started.data);
      assert.equal(pending.id, id);
      assert.equal(pending.artifact, undefined);
      assert.equal(
        (await call({ ...request, path: "/fixtures/other.txt" })).status,
        "invalid_input",
      );
      assert.equal((await call({ ...request, id: randomUUID() })).status, "invalid_input");
      assert.equal((await call(request)).status, "ok");
      assert.equal(sent.length, 1);
      const message = sent[0];
      assert.ok(message && message.payload.kind === "execute");
      assert.deepEqual(message.payload.operation, operation);
      const content = Buffer.from("captured fixture");
      const sha256 = createHash("sha256").update(content).digest("hex");
      const objects = new Set<string>();
      const artifacts = createArtifactService(database, {
        async upload(owner, source, object) {
          assert.ok(object.id);
          const chunks: Uint8Array[] = [];
          for await (const chunk of source) chunks.push(chunk);
          assert.deepEqual(Buffer.concat(chunks), content);
          objects.add(object.id);
          return { ...object, id: object.id, ownerId: owner };
        },
        verify: (_owner, object) =>
          objects.has(object.id)
            ? Promise.resolve(true)
            : Promise.reject(new MissingStoredObject()),
        downloadUrl: () => {
          throw new Error("No external download");
        },
        remove: () => {
          throw new Error("No external deletion");
        },
      });
      const receive = createDeviceFileReceiver({ database, artifacts });
      const captured = await receive(
        ownerId,
        setup.session.deviceId,
        {
          version: 1,
          authority: {
            session: setup.session,
            executionId: pending.executionId,
            transferId: operation.transferId,
            operation: "file.read",
          },
          size: content.length,
          sha256,
        },
        [content],
        new AbortController().signal,
      );
      assert.equal(captured.status, "ready");
      const resultRequest = {
        version: 1 as const,
        command: "devices.result" as const,
        id,
        after: -1,
      };
      const uploaded = await call(resultRequest);
      assert.equal(uploaded.status, "ok");
      assert.equal(cliDeviceResultSchema.parse(uploaded.data).artifact, undefined);
      await database.transaction(ownerId, async (scope) => {
        await scope.deviceExecutions.receipt({
          ...message,
          messageId: randomUUID(),
          correlationId: message.messageId,
          payload: {
            kind: "status",
            executionId: pending.executionId,
            taskId: worker.id,
            taskRevision: worker.revision,
            sequence: 0,
            state: "succeeded",
            exitCode: 0,
          },
        });
        await scope.actions.reconcileDevice(pending.executionId);
        await scope.deviceSessions.close(setup.session);
      });
      const completed = await call(resultRequest);
      assert.equal(completed.status, "ok");
      const receipt = cliDeviceResultSchema.parse(completed.data);
      assert.equal(receipt.state, "succeeded");
      assert.ok("artifactId" in captured);
      assert.deepEqual(receipt.artifact, {
        id: captured.artifactId,
        revision: captured.revision,
        name: "report.txt",
        mediaType: "application/octet-stream",
        size: content.length,
        sha256,
      });
      assert.equal((await call(request)).status, "ok");
      assert.equal(sent.length, 1);
      await sql`UPDATE winston.artifacts SET document = jsonb_set(document, '{metadata,source,origin,path}', '"/fixtures/forged.txt"'::jsonb) WHERE owner_id = ${ownerId}::uuid AND id = ${captured.artifactId}::uuid`;
      assert.equal((await call(resultRequest)).status, "denied");
      await sql`UPDATE winston.artifacts SET document = jsonb_set(document, '{metadata,source,origin,path}', to_jsonb(${request.path}::text)) WHERE owner_id = ${ownerId}::uuid AND id = ${captured.artifactId}::uuid`;
      await database.transaction(ownerId, ({ artifacts: records }) =>
        records.beginDelete(captured.artifactId, captured.revision),
      );
      assert.equal((await call(resultRequest)).status, "unavailable");
      await database.transaction(ownerId, async ({ devices }) => {
        const device = await devices.find(setup.session.deviceId);
        assert.ok(device);
        await devices.revoke(device.id, device.revision);
      });
      assert.equal((await call(resultRequest)).status, "denied");
    } finally {
      await database.close();
    }
  });
}, 120_000);
