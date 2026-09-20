import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type DatabaseTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];
export type Owner = typeof schema.owners.$inferSelect;

export interface OwnerRepository {
  find(): Promise<Owner | undefined>;
  ensure(): Promise<Owner>;
}

export function ownerRepository(
  transaction: DatabaseTransaction,
  ownerId: string,
): OwnerRepository {
  return {
    async find() {
      const rows = await transaction
        .select()
        .from(schema.owners)
        .where(eq(schema.owners.id, ownerId));

      return rows[0];
    },
    async ensure() {
      await transaction.insert(schema.owners).values({ id: ownerId }).onConflictDoNothing();
      const rows = await transaction
        .select()
        .from(schema.owners)
        .where(eq(schema.owners.id, ownerId));
      const owner = rows[0];

      if (!owner) throw new Error("Owner was not created.");

      return owner;
    },
  };
}
