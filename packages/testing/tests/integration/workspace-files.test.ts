import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createArtifactService, createWorkspaceFilePublisher } from "@winston/adapters/artifacts";
import { storedObjectSchema } from "@winston/contracts/storage";
import { UncertainObjectUpload } from "@winston/adapters/storage";
import { withTestPostgres } from "../../src/postgres";

test("workspace publication derives provenance and keeps incomplete or unauthorized files private", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    let uploads = 0;
    let uncertain = false;
    let verified = false;
    const count = () => uploads;
    const service = createArtifactService(database, {
      upload: async (owner, source, expected) => {
        uploads += 1;
        for await (const chunk of source) assert.ok(chunk instanceof Uint8Array);
        const object = storedObjectSchema.parse({ ...expected, ownerId: owner });
        if (uncertain) throw new UncertainObjectUpload(object);
        return object;
      },
      verify: () => Promise.resolve(verified),
      downloadUrl: () => Promise.resolve("https://storage.invalid/fixture"),
      remove: () => Promise.resolve(),
    });
    const publish = createWorkspaceFilePublisher({ database, artifacts: service });
    const request = {
      version: 1 as const,
      key: "report",
      name: "report.txt",
      mediaType: "text/plain",
      size: 3,
      sha256: createHash("sha256").update("abc").digest("hex"),
    };
    function* bytes(value = "abc") {
      yield Buffer.from(value);
    }
    const signal = new AbortController().signal;
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await database.transaction(ownerId, async ({ workspaces }) => {
        await workspaces.register(workspaceId, "Files fixture");
        await workspaces.setState(workspaceId, 0, "active");
      });
      const start = () =>
        database.transaction(ownerId, async ({ tasks, capabilities }) => {
          const queued = await tasks.create({
            key: randomUUID(),
            objective: "Publish file",
            sourceMessageIds: [],
          });
          const task = await tasks.claim(queued.id, queued.revision);
          const capability = await capabilities.issue({
            kind: "workspace",
            subjectId: workspaceId,
            resourceId: workspaceId,
            resourceRevision: 1,
            taskId: task.id,
            revision: task.revision,
            generation: task.generation,
            operation: "gateway:control",
            credential: null,
          });
          return {
            task,
            capability,
            credential: {
              token: capability.token,
              kind: "workspace" as const,
              subjectId: workspaceId,
              resourceId: workspaceId,
              operation: "gateway:control" as const,
            },
          };
        });
      const first = await start();
      const result = await publish(first.credential, request, bytes(), signal);
      assert.equal(result.status, "ok");
      assert.ok(JSON.stringify(result).includes(first.task.id));
      assert.ok(JSON.stringify(result).includes(workspaceId));
      assert.deepEqual(await publish(first.credential, request, bytes(), signal), result);
      assert.equal(count(), 1);
      assert.equal(
        (await publish(first.credential, { ...request, name: "changed.txt" }, bytes(), signal))
          .status,
        "unavailable",
      );
      assert.equal(count(), 1);
      const second = await start();
      const other = await publish(second.credential, request, bytes(), signal);
      assert.equal(other.status, "ok");
      assert.notDeepEqual(other, result);
      assert.equal(count(), 2);
      for (const [key, value] of [
        ["short", "ab"],
        ["long", "abcd"],
        ["checksum", "xyz"],
      ] as const) {
        assert.equal(
          (await publish(first.credential, { ...request, key }, bytes(value), signal)).status,
          "unavailable",
        );
      }
      assert.equal((await service.list(ownerId)).length, 2);
      uncertain = true;
      const uncertainRequest = { ...request, key: "uncertain" };
      assert.equal(
        (await publish(first.credential, uncertainRequest, bytes(), signal)).status,
        "unknown",
      );
      const attempted = count();
      uncertain = false;
      verified = true;
      assert.equal(
        (await publish(first.credential, uncertainRequest, bytes(), signal)).status,
        "ok",
      );
      assert.equal(count(), attempted);
      verified = false;
      const interrupted = await start();
      async function* revokedBytes() {
        await database.transaction(ownerId, ({ capabilities }) =>
          capabilities.revoke(interrupted.capability.id),
        );
        yield Buffer.from("abc");
      }
      assert.equal(
        (await publish(interrupted.credential, request, revokedBytes(), signal)).status,
        "denied",
      );
      assert.equal((await service.list(ownerId)).length, 3);
      await database.transaction(ownerId, ({ capabilities }) =>
        capabilities.revoke(first.capability.id),
      );
      assert.equal((await publish(first.credential, request, bytes(), signal)).status, "denied");
      const before = count();
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({
          target: { kind: "workspace", id: workspaceId, resource: null },
          operation: "workspace.file.read",
          decision: "ask",
          revision: 0,
        }),
      );
      assert.equal(
        (await publish(second.credential, { ...request, key: "approval" }, bytes(), signal)).status,
        "waiting",
      );
      assert.equal(count(), before);
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({
          target: { kind: "workspace", id: workspaceId, resource: null },
          operation: "workspace.file.read",
          decision: "deny",
          revision: 1,
        }),
      );
      assert.equal((await publish(second.credential, request, bytes(), signal)).status, "denied");
      assert.equal(count(), before);
    } finally {
      await database.close();
    }
  });
});
