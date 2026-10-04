import { describe, expect, test } from "bun:test";
import { s3BlobStore, type BlobObjects } from "./store.ts";

/** In-memory objects. */
function memoryObjects() {
  const objects = new Map<string, Uint8Array>();
  const store: BlobObjects = {
    put(key, bytes) {
      objects.set(key, bytes);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(objects.get(key)),
    delete(key) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
  return { store, objects };
}

describe("s3BlobStore", () => {
  test("stores bytes under their SHA-256, once for identical files", async () => {
    const { store, objects } = memoryObjects();
    const blobs = s3BlobStore(store);
    const bytes = new TextEncoder().encode("a screenshot");
    const key = await blobs.put(bytes);
    expect(key).toBe(
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    );
    expect(await blobs.put(new TextEncoder().encode("a screenshot"))).toBe(key);
    expect([...objects.keys()]).toEqual([key]);
    expect(await blobs.get(key)).toEqual(bytes);
  });

  test("deletes, and deleting again or a missing blob is fine", async () => {
    const { store, objects } = memoryObjects();
    const blobs = s3BlobStore(store);
    const key = await blobs.put(new Uint8Array([1, 2, 3]));
    await blobs.delete(key);
    await blobs.delete(key);
    expect(objects.size).toBe(0);
    expect(blobs.get(key)).rejects.toThrow(/No blob/);
  });

  test("refuses keys that aren't a SHA-256", () => {
    const blobs = s3BlobStore(memoryObjects().store);
    expect(blobs.get("../secrets")).rejects.toThrow(/Not a blob key/);
    expect(blobs.delete("users/u_1/x")).rejects.toThrow(/Not a blob key/);
  });
});
