import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createObjectStorage } from "@winston/adapters/storage";

const options = {
  endpoint: "https://storage.invalid",
  bucket: "fixture",
  region: "auto",
  accessKeyId: "synthetic",
  secretAccessKey: "synthetic",
};
const object = {
  ownerId: randomUUID(),
  id: randomUUID(),
  purpose: "artifact" as const,
  size: 3,
  sha256: createHash("sha256").update("abc").digest("hex"),
};

test("object transport rejects foreign owners, invalid configuration and sharing backups", async () => {
  assert.throws(() => createObjectStorage({ ...options, endpoint: "http://storage.invalid" }));
  assert.throws(() => createObjectStorage({ ...options, secretAccessKey: "" }));
  const storage = createObjectStorage(options);
  try {
    const stranger = randomUUID();
    await assert.rejects(storage.read(stranger, object), /unavailable/);
    await assert.rejects(storage.remove(stranger, object), /unavailable/);
    await assert.rejects(storage.verify(stranger, object), /unavailable/);
    await assert.rejects(storage.downloadUrl(stranger, object), /unavailable/);
    await assert.rejects(
      storage.downloadUrl(object.ownerId, { ...object, purpose: "backup" }),
      /Only artifacts/,
    );
    await assert.rejects(storage.downloadUrl(object.ownerId, object, 301), /expiry/);
    await assert.rejects(storage.downloadUrl(object.ownerId, object, 0), /expiry/);
    await assert.rejects(
      storage.cleanPartialUploads(object.ownerId, new Date()),
      /older than a day/,
    );
    const url = new URL(await storage.downloadUrl(object.ownerId, object, 30));
    assert.equal(url.pathname, `/${object.ownerId}/artifact/${object.id}`);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "30");
    assert.equal(url.searchParams.get("response-content-disposition"), "attachment");
    assert.equal(url.searchParams.get("response-content-type"), "application/octet-stream");
    assert.ok(url.searchParams.get("X-Amz-Signature"));
  } finally {
    storage.close();
  }
});

test("small invalid and interrupted uploads never reach object storage", async () => {
  const storage = createObjectStorage(options);
  try {
    const source = function* () {
      yield new TextEncoder().encode("wrong");
    };
    await assert.rejects(storage.upload(object.ownerId, source(), object), /before completion/);
    await assert.rejects(
      storage.upload(object.ownerId, source(), { ...object, size: 5 }),
      /before completion/,
    );
    const interrupted = function* () {
      yield new TextEncoder().encode("a");
      throw new Error("Interrupted source");
    };
    await assert.rejects(
      storage.upload(object.ownerId, interrupted(), object),
      /before completion/,
    );
    await assert.rejects(
      storage.upload(object.ownerId, source(), object, AbortSignal.abort()),
      /before completion/,
    );
  } finally {
    storage.close();
  }
});
