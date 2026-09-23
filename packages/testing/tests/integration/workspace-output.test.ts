import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createArtifactService } from "@winston/adapters/artifacts";
import { archiveCommandOutput } from "@winston/adapters/workspace";
import type { createObjectStorage } from "@winston/adapters/storage";
import { storedObjectSchema } from "@winston/contracts/storage";
import type { WorkspaceOperation } from "@winston/contracts/workspace";
import { withTestPostgres } from "../../src/postgres";

test("captured output becomes one verified owner artifact and bad bytes remain unpublished", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    const workspaceId = randomUUID();
    const bytes = Buffer.alloc(8192, "x");
    const metadata = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      preview: "x".repeat(1024),
      truncated: true,
    };
    let transfers = 0;
    let canceled = 0;
    let invalid = false;
    const storage: Pick<
      ReturnType<typeof createObjectStorage>,
      "upload" | "verify" | "downloadUrl" | "remove"
    > = {
      async upload(owner, source, expected) {
        transfers += 1;
        const chunks: Uint8Array[] = [];
        for await (const chunk of source) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        assert.equal(body.length, expected.size);
        assert.equal(createHash("sha256").update(body).digest("hex"), expected.sha256);
        assert.deepEqual(body, bytes);
        return storedObjectSchema.parse({ ...expected, ownerId: owner });
      },
      verify: () => Promise.resolve(true),
      downloadUrl: () => Promise.resolve("https://storage.invalid/output"),
      remove: () => Promise.resolve(),
    };
    const artifacts = createArtifactService(database, storage);
    const client = {
      output: () => {
        let sent = false;
        return Promise.resolve({
          metadata,
          stream: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent) controller.close();
              else {
                sent = true;
                controller.enqueue(invalid ? Buffer.alloc(8192, "y") : bytes);
              }
            },
            cancel() {
              canceled += 1;
            },
          }),
        });
      },
    };
    const operation: WorkspaceOperation = {
      version: 1,
      identity: { ownerId, workspaceId },
      operationId: randomUUID(),
      taskId: randomUUID(),
      revision: 1,
      generation: 1,
      kind: "command:execute",
      inputHash: "a".repeat(64),
    };
    const credential = {
      token: `wst_${"a".repeat(43)}`,
      kind: "worker" as const,
      subjectId: randomUUID(),
      operation: "workspace:observe" as const,
      resourceId: workspaceId,
    };
    const options = {
      ownerId,
      credential,
      operation,
      channel: "stdout" as const,
      client,
      artifacts,
    };
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await database.transaction(other, ({ owners }) => owners.ensure());
      const first = await archiveCommandOutput(options);
      assert.ok(first);
      assert.equal(first.state, "ready");
      assert.equal(first.metadata.size, bytes.length);
      assert.equal(first.metadata.source.reference, operation.operationId);
      const duplicate = await archiveCommandOutput(options);
      assert.equal(duplicate?.id, first.id);
      assert.equal(transfers, 1);
      assert.ok(canceled > 0, "unused duplicate response must be canceled");
      assert.equal(await artifacts.download(other, first.id), null);
      assert.deepEqual(await artifacts.list(other), []);
      await assert.rejects(archiveCommandOutput({ ...options, ownerId: other }), /owner mismatch/);
      invalid = true;
      const failed = await archiveCommandOutput({
        ...options,
        operation: { ...operation, operationId: randomUUID() },
      });
      assert.equal(failed?.state, "failed");
      assert.ok(failed);
      assert.equal(await artifacts.download(ownerId, failed.id), null);
      assert.equal((await artifacts.list(ownerId)).length, 1);
    } finally {
      await database.close();
    }
  });
});
