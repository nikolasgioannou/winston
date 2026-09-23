import type { ArtifactMetadata } from "@winston/contracts/artifacts";
import type { OwnerTransaction } from "../database";
import { MissingStoredObject, UncertainObjectUpload, type createObjectStorage } from "../storage";
export { createWorkspaceFilePublisher } from "./workspace-files";
export { createArtifactReader } from "./read";
export { stageInboxFile } from "./stage-inbox";

type Store = {
  transaction<Result>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "artifacts">) => Promise<Result>,
  ): Promise<Result>;
};
type Storage = Pick<
  ReturnType<typeof createObjectStorage>,
  "upload" | "verify" | "downloadUrl" | "remove"
>;

export function createArtifactService(database: Store, storage: Storage) {
  const find = (ownerId: string, id: string) =>
    database.transaction(ownerId, ({ artifacts }) => artifacts.find(id));

  return {
    list: (ownerId: string, afterId?: string) =>
      database.transaction(ownerId, ({ artifacts }) => artifacts.list(afterId)),
    // Trusted intake adapters supply metadata and bytes. They may not publish arbitrary object references.
    async upload(
      ownerId: string,
      key: string,
      metadata: ArtifactMetadata,
      source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
      signal?: AbortSignal,
    ) {
      const prepared = await database.transaction(ownerId, ({ artifacts }) =>
        artifacts.prepare(key, metadata),
      );
      const { artifact } = prepared;
      if (!prepared.created) return artifact;
      try {
        await storage.upload(ownerId, source, artifact.object, signal);
      } catch (error) {
        return database.transaction(ownerId, async ({ artifacts }) => {
          const result =
            error instanceof UncertainObjectUpload
              ? await artifacts.uncertain(artifact.id, artifact.revision)
              : await artifacts.fail(artifact.id, artifact.revision);
          return result ?? artifacts.find(artifact.id);
        });
      }
      // A disconnected commit stays recoverable using the object identity persisted before upload.
      return database.transaction(ownerId, ({ artifacts }) =>
        artifacts.ready(artifact.id, artifact.revision),
      );
    },
    async reconcile(ownerId: string, id: string) {
      const artifact = await find(ownerId, id);
      if (!artifact || !["uploading", "verifying"].includes(artifact.state)) return artifact;
      if (!(await storage.verify(ownerId, artifact.object))) return artifact;
      return database.transaction(ownerId, ({ artifacts }) =>
        artifacts.ready(id, artifact.revision),
      );
    },
    // Trusted intake recovery only. The immutable catalog identity determines all upload fields.
    async resumeUpload(
      ownerId: string,
      id: string,
      source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
      signal?: AbortSignal,
    ) {
      const artifact = await find(ownerId, id);
      if (!artifact || !["uploading", "verifying"].includes(artifact.state)) return artifact;
      signal?.throwIfAborted();
      let absent = false;
      try {
        if (!(await storage.verify(ownerId, artifact.object))) return artifact;
      } catch (error) {
        if (!(error instanceof MissingStoredObject)) throw error;
        absent = true;
      }
      if (absent) {
        signal?.throwIfAborted();
        const current = await find(ownerId, id);
        if (!current || current.revision !== artifact.revision) return current;
        try {
          // Conditional object completion also protects against an older uploader finishing late.
          await storage.upload(ownerId, source, artifact.object, signal);
        } catch {
          return database.transaction(
            ownerId,
            async ({ artifacts }) =>
              (await artifacts.uncertain(id, artifact.revision)) ?? artifacts.find(id),
          );
        }
      }
      const result = await database.transaction(
        ownerId,
        async ({ artifacts }) =>
          (await artifacts.ready(id, artifact.revision)) ?? artifacts.find(id),
      );
      if (result && ["deleting", "deleted"].includes(result.state))
        await storage.remove(ownerId, artifact.object);
      return result;
    },
    async download(ownerId: string, id: string) {
      // Hold the row through local signing so a concurrent tombstone cannot precede link issuance.
      return database.transaction(ownerId, async ({ artifacts }) => {
        const artifact = await artifacts.find(id, true);
        if (artifact?.state !== "ready") return null;
        return {
          url: await storage.downloadUrl(ownerId, artifact.object, 60, artifact.metadata.name),
          expiresIn: 60,
          name: artifact.metadata.name,
        };
      });
    },
    async remove(ownerId: string, id: string) {
      const artifact = await find(ownerId, id);
      if (!artifact || artifact.state === "deleted") return artifact;
      const deleting =
        artifact.state === "deleting"
          ? artifact
          : await database.transaction(ownerId, ({ artifacts }) =>
              artifacts.beginDelete(id, artifact.revision),
            );
      if (!deleting) return null;
      await storage.remove(ownerId, deleting.object);
      return database.transaction(ownerId, ({ artifacts }) =>
        artifacts.finishDelete(id, deleting.revision),
      );
    },
  };
}
