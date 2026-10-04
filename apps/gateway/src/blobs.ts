/**
 * Reading blobs (docs/design.md §12), which agents writes: the raw mail in
 * Winston's own mailbox, for its attachments. The S3 `blobs` bucket in
 * production, agents' directory locally.
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A blob key is a SHA-256 in hex, so it can't name anything outside the directory. */
function checkedKey(key: string) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`Not a blob key: ${key}`);
  return key;
}

export type ReadBlob = (key: string) => Promise<Uint8Array>;

export function blobReader(config: {
  BLOB_BUCKET?: string | undefined;
  BLOB_DIR: string;
}): ReadBlob {
  const bucket = config.BLOB_BUCKET;
  if (!bucket)
    return async (key) =>
      new Uint8Array(await readFile(join(config.BLOB_DIR, checkedKey(key))));
  const client = new S3Client();
  return async (key) => {
    const { Body } = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: checkedKey(key) }),
    );
    if (!Body) throw new Error(`No blob ${key}`);
    return Body.transformToByteArray();
  };
}
