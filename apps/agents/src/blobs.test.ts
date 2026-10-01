import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import {
  localBlobStore,
  s3BlobStore,
  storableMessage,
  type BlobObjects,
} from "./blobs.ts";

describe("storableMessage", () => {
  test("images in tool results go to blob storage and become a text stub", async () => {
    const dir = await mkdtemp(join(tmpdir(), "winston-blobs-"));
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    const data = Buffer.from(bytes).toString("base64");
    const message: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "view_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: "~/shot.png (800×600 PNG)" },
              {
                type: "file",
                mediaType: "image/png",
                data: { type: "data", data },
              },
            ],
          },
        },
      ],
    };
    const stored = await storableMessage(message, localBlobStore(dir));
    const json = JSON.stringify(stored);
    expect(json.length).toBeLessThan(1_000);
    const key = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(json).toContain(`stored as blob ${key}`);
    expect(json).toContain("~/shot.png (800×600 PNG)");
    expect(
      new Uint8Array(await Bun.file(join(dir, key)).arrayBuffer()),
    ).toEqual(bytes);
  });

  test("other messages are stored as they are", async () => {
    const dir = await mkdtemp(join(tmpdir(), "winston-blobs-"));
    const message: ModelMessage = { role: "user", content: "hi" };
    expect(await storableMessage(message, localBlobStore(dir))).toBe(message);
  });
});

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
