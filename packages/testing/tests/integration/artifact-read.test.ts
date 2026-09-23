import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createArtifactReader } from "@winston/adapters/artifacts";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("artifact delivery reads verify bytes, bound memory and suppress deleted or foreign files", async () => {
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
    let reads = 0;
    let cancellations = 0;
    let body = "abc";
    let close = true;
    let afterRead = async () => {};
    const read = createArtifactReader(database, {
      async read(ownerId) {
        assert.equal(ownerId, owner);
        reads++;
        await afterRead();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            if (close) controller.close();
          },
          cancel() {
            cancellations++;
          },
        });
      },
    });
    try {
      await database.transaction(owner, ({ owners }) => owners.ensure());
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      const prepared = await database.transaction(owner, ({ artifacts }) =>
        artifacts.prepare("fixture", metadata),
      );
      const id = prepared.artifact.id;
      assert.equal(await read(owner, id, 3), null);
      await database.transaction(owner, ({ artifacts }) => artifacts.ready(id, 0));
      assert.equal(await read(stranger, id, 3), null);
      await assert.rejects(read(owner, id, 2), /delivery limit/);
      await assert.rejects(read(owner, id, Number.MAX_SAFE_INTEGER), /read limit/);
      await assert.rejects(read(owner, id, 3, AbortSignal.abort()));
      assert.equal(reads, 0);
      assert.equal((await read(owner, id, 3))?.bytes.toString(), "abc");

      body = "ab";
      await assert.rejects(read(owner, id, 3), /size or checksum/);
      body = "abd";
      await assert.rejects(read(owner, id, 3), /size or checksum/);
      body = "abcd";
      close = false;
      await assert.rejects(read(owner, id, 3), /declared size/);
      assert.equal(cancellations, 1);

      body = "abc";
      const controller = new AbortController();
      afterRead = () => {
        setTimeout(() => {
          controller.abort();
        }, 20);
        return Promise.resolve();
      };
      await assert.rejects(read(owner, id, 3, controller.signal));
      assert.equal(cancellations, 2);

      close = true;
      afterRead = async () => {
        await database.transaction(owner, ({ artifacts }) => artifacts.beginDelete(id, 1));
      };
      assert.equal(await read(owner, id, 3), null);
      const previousReads = reads;
      assert.equal(await read(owner, id, 3), null);
      assert.equal(reads, previousReads);
    } finally {
      await database.close();
    }
  });
});
