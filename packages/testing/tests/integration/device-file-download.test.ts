import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDeviceFileDownloader } from "@winston/adapters/artifacts";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";
import { deviceWriteFixture } from "./device-write-fixture";

test("native downloads stream only the approved bytes and withhold completion on source failure", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      let port = 11200;
      for (const mode of [
        "valid",
        "empty",
        "short",
        "long",
        "corrupt",
        "revoked",
        "revoked-midstream",
        "storage-error",
        "abort",
        "cancel",
        "blocked",
      ] as const) {
        const content =
          mode === "empty"
            ? Buffer.alloc(0)
            : Buffer.alloc(mode === "revoked-midstream" ? 2_000_000 : 200_000, 17);
        const f = await deviceWriteFixture(database, ++port, "workspace", content);
        const input = { version: 1 as const, authority: f.authority };
        const controller = new AbortController();
        let opened = 0;
        let pulled = 0;
        let canceled = false;
        let offset = 0;
        const actual =
          mode === "short"
            ? content.subarray(0, content.length - 1)
            : mode === "long"
              ? Buffer.concat([content, Buffer.from([0])])
              : mode === "corrupt"
                ? Buffer.alloc(content.length, 18)
                : content;
        const download = createDeviceFileDownloader({
          database,
          storage: {
            read(owner, object, signal) {
              opened += 1;
              assert.equal(owner, f.ownerId);
              assert.deepEqual(object, f.artifact.object);
              assert.ok(signal);
              return Promise.resolve(
                new ReadableStream<Uint8Array>(
                  {
                    async pull(stream) {
                      pulled += 1;
                      if (mode === "blocked") return new Promise<void>(() => {});
                      if (mode === "revoked-midstream" && offset === 15 * 65_536)
                        await database.transaction(f.ownerId, ({ artifacts }) =>
                          artifacts.beginDelete(f.artifact.id, f.artifact.revision),
                        );
                      if (offset === actual.length) {
                        if (mode === "revoked")
                          await database.transaction(f.ownerId, ({ artifacts }) =>
                            artifacts.beginDelete(f.artifact.id, f.artifact.revision),
                          );
                        if (mode === "storage-error")
                          stream.error(new Error("Fixture storage failure"));
                        else stream.close();
                        return;
                      }
                      const chunk = actual.subarray(offset, offset + 65_536);
                      offset += chunk.length;
                      stream.enqueue(chunk);
                    },
                    cancel() {
                      canceled = true;
                    },
                  },
                  { highWaterMark: 0 },
                ),
              );
            },
          },
        });
        assert.equal(await download(f.ownerId, f.session.deviceId, input, controller.signal), null);
        assert.equal(opened, 0);
        assert.equal((await f.reserve()).status, "reserved");
        assert.equal(await download(f.ownerId, randomUUID(), input, controller.signal), null);
        assert.equal(opened, 0);
        const result = await download(f.ownerId, f.session.deviceId, input, controller.signal);
        assert.ok(result, mode);
        assert.deepEqual(result.source, f.operation.source);
        if (mode !== "empty")
          assert.equal(opened, 0, "Storage stays lazy until the consumer reads");
        const reader = result.body.getReader();
        const collected: Uint8Array[] = [];
        if (mode === "blocked") {
          const pending = reader.read();
          const timeout = setTimeout(() => {
            controller.abort();
          }, 20);
          try {
            await assert.rejects(pending);
          } finally {
            clearTimeout(timeout);
          }
          assert.equal(canceled, true);
          continue;
        }
        if (mode === "abort" || mode === "cancel") {
          const first = await reader.read();
          assert.ok(!first.done);
          assert.equal(pulled, 2, "Only one lookahead chunk is buffered");
          if (mode === "abort") {
            controller.abort();
            await assert.rejects(reader.read());
          } else await reader.cancel();
          assert.equal(canceled, true);
          continue;
        }
        const consume = async () => {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            assert.ok(next.value.byteLength <= 65_536);
            collected.push(next.value);
          }
        };
        if (mode === "valid" || mode === "empty") {
          await consume();
          assert.deepEqual(Buffer.concat(collected), content);
        } else {
          await assert.rejects(consume());
          assert.ok(Buffer.concat(collected).length < content.length, mode);
          if (mode === "revoked-midstream") assert.ok(Buffer.concat(collected).length < 1_048_576);
        }
      }
    } finally {
      await database.close();
    }
  });
}, 120_000);
