import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createArtifactService } from "@winston/adapters/artifacts";
import { MissingStoredObject } from "@winston/adapters/storage";
import { storedObjectSchema } from "@winston/contracts/storage";
import { withTestPostgres } from "../../src/postgres";

test("artifact recovery reuses immutable identities and distinguishes absence from uncertainty", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const metadata = {
      name: "fixture.txt",
      mediaType: "text/plain",
      size: 3,
      sha256: createHash("sha256").update("abc").digest("hex"),
      source: { kind: "telegram" as const, reference: "fixture" },
    };
    let mode = "absent";
    let failUpload = false;
    const uploads: string[] = [];
    const removed: string[] = [];
    let afterUpload: (id: string) => Promise<void> = () => Promise.resolve();
    const service = createArtifactService(database, {
      verify: () => {
        if (mode === "absent") return Promise.reject(new MissingStoredObject());
        if (mode === "unavailable") return Promise.reject(new Error("Unavailable"));
        return Promise.resolve(mode === "present");
      },
      upload: async (owner, source, expected) => {
        const object = storedObjectSchema.parse({ ...expected, ownerId: owner });
        assert.equal(object.sha256, metadata.sha256);
        assert.equal(object.size, metadata.size);
        uploads.push(object.id);
        for await (const chunk of source) assert.equal(Buffer.from(chunk).toString(), "abc");
        if (failUpload) throw new Error("Interrupted upload");
        await afterUpload(object.id);
        return object;
      },
      downloadUrl: () => Promise.resolve("https://storage.invalid"),
      remove: (_owner, object) => {
        removed.push(object.id);
        return Promise.resolve();
      },
    });
    const prepare = () =>
      database.transaction(ownerId, ({ artifacts }) => artifacts.prepare(randomUUID(), metadata));
    const bytes = [Buffer.from("abc")];
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      const first = (await prepare()).artifact;
      assert.equal(await service.resumeUpload(randomUUID(), first.id, bytes), null);
      assert.equal((await service.resumeUpload(ownerId, first.id, bytes))?.state, "ready");
      assert.equal((await service.resumeUpload(ownerId, first.id, bytes))?.state, "ready");
      assert.deepEqual(uploads, [first.id]);
      mode = "present";
      const present = (await prepare()).artifact;
      assert.equal((await service.resumeUpload(ownerId, present.id, bytes))?.state, "ready");
      assert.deepEqual(uploads, [first.id]);
      mode = "unavailable";
      const unknown = (await prepare()).artifact;
      await assert.rejects(service.resumeUpload(ownerId, unknown.id, bytes), /Unavailable/);
      assert.deepEqual(uploads, [first.id]);
      mode = "mismatch";
      assert.equal((await service.resumeUpload(ownerId, unknown.id, bytes))?.state, "uploading");
      assert.deepEqual(uploads, [first.id]);
      mode = "absent";
      failUpload = true;
      assert.equal((await service.resumeUpload(ownerId, unknown.id, bytes))?.state, "verifying");
      failUpload = false;
      assert.equal((await service.resumeUpload(ownerId, unknown.id, bytes))?.state, "ready");
      assert.deepEqual(uploads, [first.id, unknown.id, unknown.id]);

      afterUpload = async (id) => {
        await database.transaction(ownerId, ({ artifacts }) => artifacts.ready(id, 0));
      };
      const concurrent = (await prepare()).artifact;
      assert.equal((await service.resumeUpload(ownerId, concurrent.id, bytes))?.state, "ready");
      afterUpload = async (id) => {
        await database.transaction(ownerId, async ({ artifacts }) => {
          await artifacts.uncertain(id, 0);
          await artifacts.beginDelete(id, 1);
          await artifacts.finishDelete(id, 2);
        });
      };
      const deleted = (await prepare()).artifact;
      assert.equal((await service.resumeUpload(ownerId, deleted.id, bytes))?.state, "deleted");
      assert.deepEqual(removed, [deleted.id]);
    } finally {
      await database.close();
    }
  });
});
