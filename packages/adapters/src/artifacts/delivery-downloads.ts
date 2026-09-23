import type { createDatabase } from "../database";
import type { createObjectStorage } from "../storage";

export function createDeliveryDownloadService(
  database: Pick<ReturnType<typeof createDatabase>, "transaction">,
  storage: Pick<ReturnType<typeof createObjectStorage>, "downloadUrl">,
) {
  return {
    inspect(ownerId: string, id: string) {
      return database.transaction(ownerId, async ({ telegramFiles }) => {
        const access = await telegramFiles.downloadAccess(id);
        if (access.kind !== "ready") return access;
        return {
          kind: "ready" as const,
          id,
          name: access.artifact.metadata.name,
          size: access.artifact.metadata.size,
          expiresAt: new Date(access.expiresAt).toISOString(),
        };
      });
    },
    download(ownerId: string, id: string) {
      return database.transaction(ownerId, async ({ telegramFiles }) => {
        const access = await telegramFiles.downloadAccess(id);
        if (access.kind !== "ready") return null;
        const expiresIn = Math.min(60, access.remaining - 1);
        return {
          url: await storage.downloadUrl(
            ownerId,
            access.artifact.object,
            expiresIn,
            access.artifact.metadata.name,
          ),
          name: access.artifact.metadata.name,
          expiresIn,
        };
      });
    },
  };
}
