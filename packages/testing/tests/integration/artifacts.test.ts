import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createArtifactService } from "@winston/adapters/artifacts";
import { UncertainObjectUpload, type createObjectStorage } from "@winston/adapters/storage";
import { storedObjectSchema, type StoredObject } from "@winston/contracts/storage";
import { withTestPostgres } from "../../src/postgres";

test("artifact catalog isolates owners, publishes only verified transfers and retains retryable deletion", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const owner = randomUUID();
    const stranger = randomUUID();
    const metadata = {
      name: "fixture.txt",
      mediaType: "text/plain",
      size: 3,
      sha256: createHash("sha256").update("abc").digest("hex"),
      source: { kind: "workspace" as const, reference: randomUUID() },
    };
    const objects = new Map<string, StoredObject>();
    let uploads = 0;
    let links = 0;
    let mode = "success";
    let failDelete = false;
    const storage: Pick<
      ReturnType<typeof createObjectStorage>,
      "upload" | "verify" | "downloadUrl" | "remove"
    > = {
      upload(ownerId, _source, expected) {
        uploads++;
        if (mode === "failure") return Promise.reject(new Error("Synthetic upload failure"));
        const object = storedObjectSchema.parse({ ...expected, ownerId });
        objects.set(object.id, object);
        return mode === "uncertain"
          ? Promise.reject(new UncertainObjectUpload(object))
          : Promise.resolve(object);
      },
      verify(ownerId, object) {
        return Promise.resolve(objects.get(object.id)?.ownerId === ownerId);
      },
      downloadUrl(ownerId, object) {
        assert.equal(objects.get(object.id)?.ownerId, ownerId);
        links++;
        return Promise.resolve("https://storage.invalid/temporary");
      },
      remove(_ownerId, object) {
        if (failDelete) return Promise.reject(new Error("Synthetic delete failure"));
        objects.delete(object.id);
        return Promise.resolve();
      },
    };
    const service = createArtifactService(database, storage);
    const bytes = [new TextEncoder().encode("abc")];
    try {
      await database.transaction(owner, ({ owners }) => owners.ensure());
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      const [first, duplicate] = await Promise.all([
        service.upload(owner, "one", metadata, bytes),
        service.upload(owner, "one", metadata, bytes),
      ]);
      assert.ok(first && duplicate);
      assert.equal(first.id, duplicate.id);
      assert.equal(uploads, 1);
      assert.equal((await service.list(owner)).length, 1);
      assert.deepEqual(await service.list(stranger), []);
      assert.equal(await service.download(stranger, first.id), null);
      assert.equal(await service.remove(stranger, first.id), null);
      assert.equal(links, 0);
      assert.ok(await service.download(owner, first.id));
      assert.equal(links, 1);
      await assert.rejects(
        service.upload(owner, "one", { ...metadata, name: "changed.txt" }, bytes),
        /conflicts/,
      );

      mode = "failure";
      const failed = await service.upload(owner, "failure", metadata, bytes);
      assert.equal(failed?.state, "failed");
      assert.ok(failed);
      assert.equal(await service.download(owner, failed.id), null);
      mode = "uncertain";
      const uncertain = await service.upload(owner, "uncertain", metadata, bytes);
      assert.equal(uncertain?.state, "verifying");
      assert.ok(uncertain);
      assert.equal(await service.download(owner, uncertain.id), null);
      assert.equal((await service.reconcile(owner, uncertain.id))?.state, "ready");

      const interrupted = await database.transaction(owner, ({ artifacts }) =>
        artifacts.prepare("interrupted", metadata),
      );
      assert.equal(await service.download(owner, interrupted.artifact.id), null);
      assert.equal((await service.reconcile(owner, interrupted.artifact.id))?.state, "uploading");
      objects.set(interrupted.artifact.id, interrupted.artifact.object);
      assert.equal((await service.reconcile(owner, interrupted.artifact.id))?.state, "ready");

      failDelete = true;
      await assert.rejects(service.remove(owner, first.id));
      assert.equal(await service.download(owner, first.id), null);
      assert.ok(!(await service.list(owner)).some((artifact) => artifact.id === first.id));
      failDelete = false;
      assert.equal((await service.remove(owner, first.id))?.state, "deleted");
      assert.equal((await service.remove(owner, first.id))?.state, "deleted");
      assert.equal(objects.has(first.id), false);
      assert.equal(
        await database.transaction(owner, ({ artifacts }) => artifacts.ready(first.id, 0)),
        null,
      );
      assert.equal((await service.upload(owner, "one", metadata, bytes))?.state, "deleted");
      assert.equal(uploads, 3);
    } finally {
      await database.close();
    }
  });
});
