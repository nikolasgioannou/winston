/**
 * Blobs (docs/design.md §12) the gateway needs: the raw mail in Winston's
 * own mailbox, read for attachments and written when he sends. The S3
 * `blobs` bucket in production, agents' directory locally; keys are the
 * SHA-256 of the bytes, as agents' blob store makes them.
 */
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A blob key is a SHA-256 in hex, so it can't name anything outside the directory. */
function checkedKey(key: string) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`Not a blob key: ${key}`);
  return key;
}

const keyOf = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export interface GatewayBlobs {
  get(key: string): Promise<Uint8Array>;
  /** Stores bytes and returns their key. */
  put(bytes: Uint8Array): Promise<string>;
}

export function gatewayBlobs(config: {
  BLOB_BUCKET?: string | undefined;
  BLOB_DIR: string;
}): GatewayBlobs {
  const bucket = config.BLOB_BUCKET;
  if (!bucket)
    return {
      get: async (key) =>
        new Uint8Array(await readFile(join(config.BLOB_DIR, checkedKey(key)))),
      async put(bytes) {
        const key = keyOf(bytes);
        await mkdir(config.BLOB_DIR, { recursive: true });
        await writeFile(join(config.BLOB_DIR, key), bytes);
        return key;
      },
    };
  const client = new S3Client();
  return {
    async get(key) {
      const { Body } = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: checkedKey(key) }),
      );
      if (!Body) throw new Error(`No blob ${key}`);
      return Body.transformToByteArray();
    },
    async put(bytes) {
      const key = keyOf(bytes);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: "application/octet-stream",
        }),
      );
      return key;
    },
  };
}
