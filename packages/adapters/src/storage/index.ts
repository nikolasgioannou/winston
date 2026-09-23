import { createHash, randomUUID } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storedObjectSchema, type StoredObject } from "@winston/contracts/storage";

const partSize = 8 * 1024 * 1024;

function key(object: StoredObject) {
  const parsed = storedObjectSchema.parse(object);
  return `${parsed.ownerId}/${parsed.purpose}/${parsed.id}`;
}

function scoped(ownerId: string, object: StoredObject) {
  const result = storedObjectSchema.parse(object);
  if (result.ownerId !== ownerId) throw new Error("Object unavailable.");
  return result;
}

export class UncertainObjectUpload extends Error {
  constructor(readonly object: StoredObject) {
    super("Object completion is uncertain; verify the stored object before publishing it.");
  }
}

// Trusted transport only. Callers must resolve ready catalog records under an authenticated
// owner before reads/signing. Object references and this client are never model tools.
export function createObjectStorage(options: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}) {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new Error("Object storage requires an HTTPS endpoint.");
  if (!options.bucket || !options.accessKeyId || !options.secretAccessKey)
    throw new Error("Object storage configuration is incomplete.");
  const client = new S3Client({
    endpoint: endpoint.origin,
    region: options.region,
    forcePathStyle: false,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    maxAttempts: 3,
  });
  const bucket = options.bucket;
  const requestOptions = (signal?: AbortSignal) => ({
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });

  async function verify(ownerId: string, input: StoredObject) {
    const object = scoped(ownerId, input);
    const result = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key(object) }),
      requestOptions(),
    );
    return result.ContentLength === object.size && result.Metadata?.sha256 === object.sha256;
  }

  return {
    close: () => {
      client.destroy();
    },
    verify,
    async upload(
      ownerId: string,
      source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
      expected: Pick<StoredObject, "size" | "sha256" | "purpose"> & { id?: string },
      signal?: AbortSignal,
    ): Promise<StoredObject> {
      // The catalog may reserve this ID before upload so crash recovery can find the object.
      const object = storedObjectSchema.parse({
        ...expected,
        ownerId,
        id: expected.id ?? randomUUID(),
      });
      const objectKey = key(object);
      const hash = createHash("sha256");
      const parts: CompletedPart[] = [];
      let uploadId: string | undefined;
      let completing = false;
      let size = 0;
      let buffer = Buffer.alloc(partSize);
      let used = 0;

      async function flush() {
        if (!uploadId) {
          const created = await client.send(
            new CreateMultipartUploadCommand({
              Bucket: bucket,
              Key: objectKey,
              ContentType: "application/octet-stream",
              Metadata: { sha256: object.sha256 },
            }),
            requestOptions(signal),
          );
          uploadId = created.UploadId;
          if (!uploadId) throw new Error("Storage did not return an upload identifier.");
        }
        const body = buffer.subarray(0, used);
        const part = await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: objectKey,
            UploadId: uploadId,
            PartNumber: parts.length + 1,
            Body: body,
            ContentLength: used,
            ContentMD5: createHash("md5").update(body).digest("base64"),
          }),
          requestOptions(signal),
        );
        if (!part.ETag) throw new Error("Storage did not acknowledge the part.");
        parts.push({ ETag: part.ETag, PartNumber: parts.length + 1 });
        buffer = Buffer.alloc(partSize);
        used = 0;
      }

      try {
        for await (const chunk of source) {
          signal?.throwIfAborted();
          size += chunk.byteLength;
          if (size > object.size) throw new Error("Object exceeds its declared size.");
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const count = Math.min(partSize - used, chunk.byteLength - offset);
            buffer.set(chunk.subarray(offset, offset + count), used);
            used += count;
            offset += count;
            if (used === partSize) await flush();
          }
        }
        signal?.throwIfAborted();
        if (size !== object.size || hash.digest("hex") !== object.sha256)
          throw new Error("Object size or checksum does not match.");
        if (used > 0) await flush();
        completing = true;
        if (uploadId) {
          await client.send(
            new CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key: objectKey,
              UploadId: uploadId,
              MultipartUpload: { Parts: parts },
              IfNoneMatch: "*",
            }),
            requestOptions(signal),
          );
        } else {
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: objectKey,
              Body: new Uint8Array(),
              ContentType: "application/octet-stream",
              Metadata: { sha256: object.sha256 },
              IfNoneMatch: "*",
            }),
            requestOptions(signal),
          );
        }
        if (!(await verify(ownerId, object))) throw new Error("Object verification failed.");
        return object;
      } catch {
        if (uploadId) {
          // A process crash or failed abort is recovered by the stale multipart sweep.
          await client
            .send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: objectKey,
                UploadId: uploadId,
              }),
              requestOptions(),
            )
            .catch(() => undefined);
        }
        if (completing) throw new UncertainObjectUpload(object);
        throw new Error("Object upload failed before completion.");
      }
    },
    async read(ownerId: string, input: StoredObject, signal?: AbortSignal) {
      const object = scoped(ownerId, input);
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 30_000);
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key(object) }),
          {
            abortSignal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          },
        );
        if (!result.Body) throw new Error("Object body unavailable.");
        const stream = result.Body.transformToWebStream();
        if (result.ContentLength !== object.size || result.Metadata?.sha256 !== object.sha256) {
          await stream.cancel();
          throw new Error("Object metadata does not match.");
        }
        return stream;
      } finally {
        // Bound waiting for headers without truncating a large streamed download after 30 seconds.
        clearTimeout(timeout);
      }
    },
    async downloadUrl(ownerId: string, input: StoredObject, expiresIn = 60, filename?: string) {
      const object = scoped(ownerId, input);
      if (object.purpose !== "artifact") throw new Error("Only artifacts can be shared.");
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 300)
        throw new Error("Download expiry must be between one and 300 seconds.");
      if (filename && filename.length > 255) throw new Error("Download filename is too long.");
      const encodedName = filename
        ? encodeURIComponent(filename).replace(
            /['()*]/g,
            (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
          )
        : null;
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key(object),
          ResponseContentType: "application/octet-stream",
          ResponseContentDisposition: encodedName
            ? `attachment; filename*=UTF-8''${encodedName}`
            : "attachment",
        }),
        { expiresIn },
      );
    },
    async remove(ownerId: string, input: StoredObject) {
      const object = scoped(ownerId, input);
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key(object) }),
        requestOptions(),
      );
    },
    // One bounded page per call; persist the returned cursor for large sweeps.
    async cleanPartialUploads(
      ownerId: string,
      before: Date,
      cursor?: { key: string; uploadId: string },
    ) {
      const owner = storedObjectSchema.shape.ownerId.parse(ownerId);
      if (!Number.isFinite(before.getTime()) || before.getTime() > Date.now() - 86_400_000)
        throw new Error("Only uploads older than a day may be swept.");
      const result = await client.send(
        new ListMultipartUploadsCommand({
          Bucket: bucket,
          Prefix: `${owner}/`,
          MaxUploads: 100,
          KeyMarker: cursor?.key,
          UploadIdMarker: cursor?.uploadId,
        }),
        requestOptions(),
      );
      for (const upload of result.Uploads ?? []) {
        if (
          upload.Key?.startsWith(`${owner}/`) &&
          upload.UploadId &&
          upload.Initiated &&
          upload.Initiated < before
        ) {
          await client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: upload.Key,
              UploadId: upload.UploadId,
            }),
            requestOptions(),
          );
        }
      }
      return result.IsTruncated && result.NextKeyMarker && result.NextUploadIdMarker
        ? { key: result.NextKeyMarker, uploadId: result.NextUploadIdMarker }
        : null;
    },
  };
}
