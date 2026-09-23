import { createHash } from "node:crypto";
import { maximumPublicationSize } from "@winston/contracts/artifacts";
import type { OwnerTransaction } from "../database";
import type { createObjectStorage } from "../storage";

type Store = {
  transaction<Result>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "artifacts">) => Promise<Result>,
  ): Promise<Result>;
};

// Resolve catalog IDs here; callers never supply storage keys or download URLs.
export function createArtifactReader(
  database: Store,
  storage: Pick<ReturnType<typeof createObjectStorage>, "read">,
) {
  return async (ownerId: string, id: string, maximumBytes: number, signal?: AbortSignal) => {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 0 ||
      maximumBytes > maximumPublicationSize
    )
      throw new Error("Invalid artifact read limit.");

    const find = () => database.transaction(ownerId, ({ artifacts }) => artifacts.find(id));
    const artifact = await find();
    if (artifact?.state !== "ready") return null;
    if (artifact.object.size > maximumBytes) throw new Error("Artifact exceeds delivery limit.");

    const deadline = AbortSignal.timeout(30_000);
    const aborted = signal ? AbortSignal.any([signal, deadline]) : deadline;
    aborted.throwIfAborted();
    const stream = await storage.read(ownerId, artifact.object, aborted);
    const reader = stream.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    aborted.addEventListener("abort", cancel, { once: true });
    try {
      aborted.throwIfAborted();
      const bytes = Buffer.alloc(artifact.object.size);
      const hash = createHash("sha256");
      let offset = 0;
      let chunk = await reader.read();
      while (!chunk.done) {
        aborted.throwIfAborted();
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new Error("Invalid artifact byte stream.");
        if (value.byteLength > bytes.byteLength - offset)
          throw new Error("Artifact exceeds its declared size.");
        bytes.set(value, offset);
        hash.update(value);
        offset += value.byteLength;
        chunk = await reader.read();
      }
      aborted.throwIfAborted();
      if (offset !== bytes.byteLength || hash.digest("hex") !== artifact.object.sha256)
        throw new Error("Artifact size or checksum does not match.");

      // A deletion during transfer must suppress delivery, without holding a DB lock over I/O.
      const current = await find();
      aborted.throwIfAborted();
      if (current?.state !== "ready" || current.revision !== artifact.revision) return null;
      return { artifact: current, bytes };
    } finally {
      aborted.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
}
