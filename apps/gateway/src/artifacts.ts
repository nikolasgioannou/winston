import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { VmManifest } from "./updates.ts";

/** Where publish-vm-binaries.ts writes the manifest, last. */
export const manifestKey = "vm/latest.json";

/**
 * Published VM binaries in the artifacts bucket (production): the manifest,
 * and presigned download URLs, so VMs need no AWS credentials to update.
 */
export function s3Artifacts(bucket: string, client = new S3Client()) {
  return {
    async loadManifest(): Promise<VmManifest | undefined> {
      try {
        const { Body } = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: manifestKey }),
        );
        return Body
          ? (JSON.parse(await Body.transformToString()) as VmManifest)
          : undefined;
      } catch (error) {
        // Nothing published yet.
        if ((error as { name?: string }).name === "NoSuchKey") return undefined;
        throw error;
      }
    },
    presign: (key: string) =>
      // Long enough to download an ~80 MB binary on a slow start.
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: 900,
      }),
  };
}
