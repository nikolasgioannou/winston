import type { createDatabase } from "../database";
import type { ProviderGrant } from "@winston/contracts/credentials";
import type { createCredentialCipher } from "./cipher";

export { createCredentialCipher, readCredentialCipher } from "./cipher";

export function createCredentialVault(
  database: ReturnType<typeof createDatabase>,
  cipher: ReturnType<typeof createCredentialCipher>,
) {
  return {
    async put(ownerId: string, id: string, grant: ProviderGrant, expectedRevision: number | null) {
      const revision = (expectedRevision ?? -1) + 1;
      const encrypted = cipher.encrypt({ ownerId, id, provider: "google", revision }, grant);
      return database.transaction(ownerId, ({ credentials }) =>
        credentials.put(id, expectedRevision, encrypted),
      );
    },
    async read(ownerId: string, id: string) {
      const row = await database.transaction(ownerId, ({ credentials }) => credentials.find(id));
      if (!row?.encrypted) return undefined;
      return { revision: row.revision, grant: cipher.decrypt(row, row.encrypted) };
    },
    async rotate(ownerId: string, id: string) {
      return database.transaction(ownerId, async ({ credentials }) => {
        const row = await credentials.find(id);
        if (!row?.encrypted) throw new Error("Credential unavailable.");
        if (row.encrypted.keyId === cipher.activeKeyId) return row.revision;
        const grant = cipher.decrypt(row, row.encrypted);
        const encrypted = cipher.encrypt({ ...row, revision: row.revision + 1 }, grant);
        return credentials.put(id, row.revision, encrypted);
      });
    },
    revoke: (ownerId: string, id: string, revision: number) =>
      database.transaction(ownerId, ({ credentials }) => credentials.revoke(id, revision)),
  };
}
