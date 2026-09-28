/**
 * Large binaries live in blob storage, referenced by key, never inline in
 * Postgres (docs/design.md §12). Locally that's a directory; production uses
 * S3 behind the same interface (M4).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";

export interface BlobStore {
  /** Stores bytes and returns their key: the SHA-256, so identical files are stored once. */
  put(bytes: Uint8Array): Promise<string>;
  get(key: string): Promise<Uint8Array>;
}

export function localBlobStore(dir: string): BlobStore {
  return {
    async put(bytes) {
      const key = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, key), bytes);
      return key;
    },
    async get(key) {
      if (!/^[0-9a-f]{64}$/.test(key))
        throw new Error(`Not a blob key: ${key}`);
      return new Uint8Array(await readFile(join(dir, key)));
    },
  };
}

/**
 * The version of a message to store in `run_messages`: every image in a tool
 * result goes to blob storage and is replaced by a text stub naming its key.
 * Later turns read the stub, so older images reach the model as text, and
 * the image itself can still be looked up.
 */
export async function storableMessage(
  message: ModelMessage,
  blobs: BlobStore,
): Promise<ModelMessage> {
  if (message.role !== "tool") return message;
  const content = await Promise.all(
    message.content.map(async (part) => {
      if (part.type !== "tool-result" || part.output.type !== "content")
        return part;
      const value = await Promise.all(
        part.output.value.map(async (item) => {
          // Read through a minimal shape: some members of the SDK's part union are deprecated.
          const file = item as {
            type: string;
            mediaType?: string;
            data?: unknown;
          };
          if (file.type !== "file" || !file.mediaType?.startsWith("image/"))
            return item;
          const tagged = file.data as
            { type?: string; data?: unknown } | undefined;
          if (tagged?.type !== "data" || typeof tagged.data !== "string")
            return item;
          const key = await blobs.put(
            new Uint8Array(Buffer.from(tagged.data, "base64")),
          );
          return {
            type: "text" as const,
            text: `[image, stored as blob ${key}; not shown again, view it again to see it]`,
          };
        }),
      );
      return { ...part, output: { ...part.output, value } };
    }),
  );
  return { ...message, content };
}
