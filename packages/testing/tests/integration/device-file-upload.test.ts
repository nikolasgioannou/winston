import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createArtifactService, createDeviceFileReceiver } from "@winston/adapters/artifacts";
import { MissingStoredObject, UncertainObjectUpload } from "@winston/adapters/storage";
import { deviceFileArtifactSchema, type DeviceFileUpload } from "@winston/contracts/artifacts";
import { storedObjectSchema } from "@winston/contracts/storage";
import type { DeviceMessage } from "@winston/contracts/devices";
import { withTestPostgres } from "../../src/postgres";

test("native file intake preserves exact device provenance and recovers immutable uploads under current authority", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const objects = new Map<string, { ownerId: string; bytes: Buffer }>();
    let uploads = 0;
    let loseReceipt = false;
    let unavailableVerification = false;
    let lastBytes = 0;
    const storage: Parameters<typeof createArtifactService>[1] = {
      async upload(ownerId, source, input, signal) {
        const object = storedObjectSchema.parse({ ...input, ownerId });
        uploads += 1;
        lastBytes = 0;
        const chunks: Uint8Array[] = [];
        for await (const chunk of source) {
          signal?.throwIfAborted();
          assert.ok(chunk.byteLength <= 65_536);
          lastBytes += chunk.byteLength;
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, object.size);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), object.sha256);
        assert.equal(objects.has(object.id), false, "Immutable object is never overwritten");
        objects.set(object.id, { ownerId, bytes });
        if (loseReceipt) {
          loseReceipt = false;
          unavailableVerification = true;
          throw new UncertainObjectUpload(object);
        }
        return object;
      },
      verify(ownerId, object) {
        const stored = objects.get(object.id);
        if (!stored) return Promise.reject(new MissingStoredObject());
        if (unavailableVerification) {
          unavailableVerification = false;
          return Promise.reject(new Error("Fixture storage verification unavailable"));
        }
        assert.equal(stored.ownerId, ownerId);
        return Promise.resolve(
          stored.bytes.length === object.size &&
            createHash("sha256").update(stored.bytes).digest("hex") === object.sha256,
        );
      },
      downloadUrl: () => {
        throw new Error("Native intake must not mint download links");
      },
      remove: () => {
        throw new Error("Native intake must not delete another artifact");
      },
    };
    const artifacts = createArtifactService(database, storage);
    const receive = createDeviceFileReceiver({ database, artifacts });
    const content = Buffer.alloc(3 * 1024 * 1024, 42);
    const digest = createHash("sha256").update(content).digest("hex");
    const fixture = async () => {
      const ownerId = randomUUID();
      return database.transaction(ownerId, async (scope) => {
        await scope.owners.ensure();
        const challenge = await scope.devices.start("Native file fixture");
        const paired = await scope.devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["file.read"],
        });
        assert.ok(paired);
        const opened = await scope.deviceSessions.open(paired.device.id, paired.credential);
        assert.ok(opened);
        const session = {
          deviceId: opened.deviceId,
          sessionId: opened.sessionId,
          generation: opened.generation,
        };
        await scope.deviceSessions.advertise(session, ["file.read"]);
        await scope.deviceSessions.heartbeat(session, "ready");
        const queued = await scope.tasks.create({
          key: randomUUID(),
          objective: "Read a fixture file",
          sourceMessageIds: [],
        });
        const running = await scope.tasks.claim(queued.id, queued.revision);
        const task = { id: running.id, revision: running.revision, generation: running.generation };
        const operation = {
          kind: "file.read" as const,
          transferId: randomUUID(),
          path: "/fixtures/plan\n.txt",
        };
        const action = await scope.deviceActions.prepare(
          task,
          "read-file",
          paired.device.id,
          operation,
        );
        await scope.actions.decide({
          id: action.id,
          revision: action.revision,
          hash: action.hash,
          approve: true,
        });
        const message: DeviceMessage = {
          version: 1,
          messageId: randomUUID(),
          correlationId: randomUUID(),
          ...session,
          payload: {
            kind: "execute",
            executionId: action.operationId,
            taskId: task.id,
            taskRevision: task.revision,
            deadline: Date.now() + 60_000,
            operation,
          },
        };
        const reserved = await scope.deviceExecutions.reserveApproved({
          id: action.id,
          hash: action.hash,
          task,
          message,
        });
        assert.equal(reserved.status, "reserved");
        const request: DeviceFileUpload = {
          version: 1,
          authority: {
            session,
            executionId: action.operationId,
            transferId: operation.transferId,
            operation: "file.read",
          },
          size: content.length,
          sha256: digest,
        };
        return { ownerId, paired, action, task, request };
      });
    };
    const unread = async function* () {
      yield await Promise.reject<Uint8Array>(new Error("This body must not be consumed"));
    };
    try {
      const first = await fixture();
      const call = (
        source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
        request = first.request,
      ) =>
        receive(
          first.ownerId,
          first.paired.device.id,
          request,
          source,
          new AbortController().signal,
        );
      const ready = await call([content]);
      assert.equal(ready.status, "ready");
      assert.ok("artifactId" in ready);
      const record = deviceFileArtifactSchema.parse(
        await database.transaction(first.ownerId, ({ artifacts }) =>
          artifacts.find(ready.artifactId),
        ),
      );
      assert.equal(record.metadata.name, "plan_.txt");
      assert.deepEqual(record.metadata.source.origin, {
        deviceId: first.paired.device.id,
        path: "/fixtures/plan\n.txt",
        executionId: first.action.operationId,
        transferId: first.request.authority.transferId,
        readActionId: first.action.id,
      });
      assert.equal(uploads, 1);
      assert.deepEqual(await call(unread()), ready);
      assert.equal(uploads, 1);
      assert.equal(
        (await call(unread(), { ...first.request, sha256: "0".repeat(64) })).status,
        "conflict",
      );
      assert.equal(
        (
          await receive(
            first.ownerId,
            randomUUID(),
            first.request,
            unread(),
            new AbortController().signal,
          )
        ).status,
        "denied",
      );

      const interrupted = await fixture();
      loseReceipt = true;
      const uncertain = await receive(
        interrupted.ownerId,
        interrupted.paired.device.id,
        interrupted.request,
        [content],
        new AbortController().signal,
      );
      assert.equal(uncertain.status, "unknown");
      const afterLoss = uploads;
      const recovered = await receive(
        interrupted.ownerId,
        interrupted.paired.device.id,
        interrupted.request,
        unread(),
        new AbortController().signal,
      );
      assert.equal(recovered.status, "ready");
      assert.equal(uploads, afterLoss, "Lost completion receipt never repeats object upload");

      const invalid = await fixture();
      const bad = await receive(
        invalid.ownerId,
        invalid.paired.device.id,
        invalid.request,
        [Buffer.alloc(content.length, 1)],
        new AbortController().signal,
      );
      assert.equal(bad.status, "invalid_file");
      const prior = await database.transaction(invalid.ownerId, ({ artifacts }) =>
        artifacts.findByKey(`device-file:${invalid.action.id}`),
      );
      assert.ok(prior);
      const retried = await receive(
        invalid.ownerId,
        invalid.paired.device.id,
        invalid.request,
        [content],
        new AbortController().signal,
      );
      assert.equal(retried.status, "ready");
      assert.ok("artifactId" in retried);
      assert.equal(retried.artifactId, prior.id);

      const canceled = await fixture();
      async function* canceledBytes() {
        yield content.subarray(0, 1_048_576);
        await database.transaction(canceled.ownerId, ({ authorization }) =>
          authorization.put({
            target: { kind: "device", id: canceled.paired.device.id, resource: null },
            operation: "device.file.read",
            decision: "deny",
            revision: 0,
          }),
        );
        yield content.subarray(1_048_576);
      }
      const denied = await receive(
        canceled.ownerId,
        canceled.paired.device.id,
        canceled.request,
        canceledBytes(),
        new AbortController().signal,
      );
      assert.equal(denied.status, "denied");
      assert.equal(lastBytes, 1_048_576, "Revocation stops the next byte batch");
      const canceledArtifact = await database.transaction(canceled.ownerId, ({ artifacts }) =>
        artifacts.findByKey(`device-file:${canceled.action.id}`),
      );
      assert.ok(canceledArtifact);
      assert.equal(objects.has(canceledArtifact.id), false);

      await assert.rejects(
        () => artifacts.remove(first.ownerId, ready.artifactId),
        /must not delete/,
      );
      assert.equal(
        (await call(unread())).status,
        "denied",
        "Tombstoned artifacts cannot be revived by replay",
      );
    } finally {
      await database.close();
    }
  });
});
