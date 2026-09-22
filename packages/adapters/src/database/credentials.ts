import { sql } from "drizzle-orm";
import {
  credentialBindingSchema,
  encryptedCredentialSchema,
  type EncryptedCredential,
} from "@winston/contracts/credentials";
import type { DatabaseTransaction } from "./owners";

export function credentialRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function find(id: string) {
    const parsedId = credentialBindingSchema.shape.id.parse(id);
    const rows = await transaction.execute<{
      provider: "google";
      revision: number;
      encrypted: unknown;
    }>(sql`
      SELECT provider, revision, encrypted FROM winston.credentials WHERE owner_id = ${ownerId}::uuid AND id = ${parsedId}::uuid
    `);
    const row = rows.rows[0];
    return row
      ? {
          id: parsedId,
          ownerId,
          provider: row.provider,
          revision: row.revision,
          encrypted: row.encrypted === null ? null : encryptedCredentialSchema.parse(row.encrypted),
        }
      : undefined;
  }
  return {
    find,
    async put(id: string, expectedRevision: number | null, encrypted: EncryptedCredential) {
      const blob = encryptedCredentialSchema.parse(encrypted);
      await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      const current = await find(id);
      if ((current?.revision ?? null) !== expectedRevision)
        throw new Error("Credential revision changed.");
      const revision = (expectedRevision ?? -1) + 1;
      await transaction.execute(sql`
        INSERT INTO winston.credentials (owner_id, id, provider, revision, encrypted)
        VALUES (${ownerId}::uuid, ${id}::uuid, 'google', ${revision}, ${JSON.stringify(blob)}::jsonb)
        ON CONFLICT (owner_id, id) DO UPDATE SET revision = EXCLUDED.revision, encrypted = EXCLUDED.encrypted
      `);
      return revision;
    },
    async revoke(id: string, expectedRevision: number) {
      const result = await transaction.execute(sql`
        UPDATE winston.credentials SET revision = revision + 1, encrypted = NULL
        WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid AND revision = ${expectedRevision} RETURNING id
      `);
      if (!result.rowCount) throw new Error("Credential unavailable or revision changed.");
    },
  };
}
export type CredentialRepository = ReturnType<typeof credentialRepository>;
