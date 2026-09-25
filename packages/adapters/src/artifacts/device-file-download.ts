import { createHash } from "node:crypto";
import {
  deviceFileDownloadSchema,
  type DeviceFileDownload,
} from "@winston/contracts/device-file-writes";
import { canonicalJson } from "@winston/contracts/json";
import type { OwnerTransaction } from "../database";
import type { createObjectStorage } from "../storage";

type Store = {
  transaction<Result>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "deviceFileWrites">) => Promise<Result>,
  ): Promise<Result>;
};

export function createDeviceFileDownloader(options: {
  database: Store;
  storage: Pick<ReturnType<typeof createObjectStorage>, "read">;
}) {
  return async (
    ownerId: string,
    authenticatedDeviceId: string,
    input: DeviceFileDownload,
    signal: AbortSignal,
  ) => {
    const request = deviceFileDownloadSchema.parse(input);
    const aborted = AbortSignal.any([signal, AbortSignal.timeout(50_000)]);
    const cancellation = new AbortController();
    const authorize = () =>
      options.database.transaction(ownerId, ({ deviceFileWrites }) =>
        deviceFileWrites.authorize(authenticatedDeviceId, request.authority),
      );
    aborted.throwIfAborted();
    const initial = await authorize();
    if (
      !initial ||
      initial.execution.message.payload.kind !== "execute" ||
      initial.execution.message.payload.operation.kind !== "file.write"
    )
      return null;
    const remaining = initial.execution.message.payload.deadline - Date.now();
    if (remaining <= 0) return null;
    const stopped = AbortSignal.any([
      aborted,
      cancellation.signal,
      AbortSignal.timeout(Math.min(50_000, remaining)),
    ]);
    const source = initial.execution.message.payload.operation.source;
    const artifact = initial.artifact;
    const current = async () => {
      stopped.throwIfAborted();
      const next = await authorize();
      stopped.throwIfAborted();
      if (!next || canonicalJson(next.artifact) !== canonicalJson(artifact))
        throw new Error("Native file source authority changed.");
    };
    async function* chunks(): AsyncGenerator<Uint8Array> {
      await current();
      const stream = await options.storage.read(ownerId, artifact.object, stopped);
      const reader = stream.getReader();
      let closing: Promise<void> | undefined;
      const cleanup = () => {
        closing ??= reader
          .cancel()
          .catch(() => {})
          .then(() => {
            reader.releaseLock();
          });
        return closing;
      };
      const abort = () => {
        void cleanup().catch(() => {});
      };
      stopped.addEventListener("abort", abort, { once: true });
      const hash = createHash("sha256");
      let size = 0;
      let checkedSize = 0;
      let checkedAt = Date.now();
      let pending: Uint8Array | undefined;
      try {
        for (;;) {
          stopped.throwIfAborted();
          const next = await reader.read();
          stopped.throwIfAborted();
          if (next.done) break;
          const value: unknown = next.value;
          if (
            !(value instanceof Uint8Array) ||
            value.byteLength === 0 ||
            value.byteLength > source.size - size
          )
            throw new Error("Native file source exceeded its size.");
          for (let offset = 0; offset < value.byteLength; offset += 65_536) {
            stopped.throwIfAborted();
            const piece = value.slice(offset, offset + 65_536);
            size += piece.byteLength;
            hash.update(piece);
            if (size - checkedSize >= 1_048_576 || Date.now() - checkedAt >= 1000) {
              await current();
              checkedSize = size;
              checkedAt = Date.now();
            }
            if (pending) yield pending;
            pending = piece;
          }
        }
        if (size !== source.size || hash.digest("hex") !== source.sha256)
          throw new Error("Native file source checksum or size changed.");
        await current();
        // Never deliver the final chunk until EOF, integrity and authority are all confirmed.
        if (pending) yield pending;
      } finally {
        stopped.removeEventListener("abort", abort);
        await cleanup();
      }
    }
    const iterator = chunks();
    // Content-Length: 0 can complete without a body read, so verify empty sources first.
    if (source.size === 0) {
      const empty = await iterator.next();
      if (!empty.done) throw new Error("Unexpected empty-file bytes.");
    }
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          cancellation.abort(new Error("Native download canceled."));
          await iterator.return(undefined);
        },
      },
      { highWaterMark: 0 },
    );
    return { source, body };
  };
}
