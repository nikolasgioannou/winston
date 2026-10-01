/**
 * Large binaries live in blob storage, referenced by key, never inline in
 * Postgres (docs/design.md §12). Locally that's a directory; production uses
 * the S3 `blobs` bucket behind the same interface.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";

export interface BlobStore {
  /** Stores bytes and returns their key: the SHA-256, so identical files are stored once. */
  put(bytes: Uint8Array): Promise<string>;
  get(key: string): Promise<Uint8Array>;
  /** Removes a blob (account deletion). One that's already gone is fine. */
  delete(key: string): Promise<void>;
}

/** A key is a SHA-256 in hex, so it can't name anything outside the directory. */
function checkedKey(key: string) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`Not a blob key: ${key}`);
  return key;
}

const keyOf = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** The S3 bucket when `BLOB_BUCKET` is set (production), else the directory. */
export function createBlobStore(config: {
  BLOB_BUCKET?: string | undefined;
  BLOB_DIR: string;
}): BlobStore {
  return config.BLOB_BUCKET
    ? s3BlobStore(awsS3Objects(config.BLOB_BUCKET))
    : localBlobStore(config.BLOB_DIR);
}

export function localBlobStore(dir: string): BlobStore {
  return {
    async put(bytes) {
      const key = keyOf(bytes);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, key), bytes);
      return key;
    },
    async get(key) {
      return new Uint8Array(await readFile(join(dir, checkedKey(key))));
    },
    async delete(key) {
      await rm(join(dir, checkedKey(key)), { force: true });
    },
  };
}

/** Objects in one bucket, by key: what the S3 store needs from S3. */
export interface BlobObjects {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Undefined when there's no such object. */
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}

/**
 * The S3 store: objects named by their SHA-256 at the bucket's root. Writing
 * the same bytes twice rewrites the same object, so there's no existence
 * check. Keys aren't per user: identical files from different users are one
 * object, and account deletion removes only blobs no one else's rows
 * reference (accounts/delete-user.ts).
 */
export function s3BlobStore(objects: BlobObjects): BlobStore {
  return {
    async put(bytes) {
      const key = keyOf(bytes);
      await objects.put(key, bytes, "application/octet-stream");
      return key;
    },
    async get(key) {
      const bytes = await objects.get(checkedKey(key));
      if (!bytes) throw new Error(`No blob ${key}`);
      return bytes;
    },
    async delete(key) {
      await objects.delete(checkedKey(key));
    },
  };
}

/** S3 through the AWS SDK; the region and credentials come from the task. */
export function awsS3Objects(bucket: string, client = new S3Client()) {
  return {
    async put(key, bytes, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
        }),
      );
    },
    async get(key) {
      try {
        const { Body } = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        return Body ? await Body.transformToByteArray() : undefined;
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return undefined;
        throw error;
      }
    },
    async delete(key) {
      // Deleting a missing object succeeds, which account deletion relies on.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  } satisfies BlobObjects;
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
