import { sql } from "drizzle-orm";
import {
  responsibilityHistorySchema,
  responsibilitySourcesSchema,
  responsibilitySchema,
  type Responsibility,
} from "@winston/contracts/responsibilities";
import type { DatabaseTransaction } from "./owners";
import { messageSources } from "./message-sources";

export async function responsibilitySources(
  transaction: DatabaseTransaction,
  ownerId: string,
  responsibility: Responsibility,
) {
  return responsibilitySourcesSchema.parse({
    id: responsibility.id,
    revision: responsibility.revision,
    items: await messageSources(transaction, ownerId, responsibility.sources),
  });
}

export async function responsibilityHistory(
  transaction: DatabaseTransaction,
  ownerId: string,
  id: string,
  before?: number,
) {
  if (before !== undefined) responsibilitySchema.shape.revision.parse(before);
  const rows = await transaction.execute<{ document: unknown }>(sql`
    SELECT document FROM winston.responsibility_history WHERE owner_id = ${ownerId}::uuid
      AND responsibility_id = ${id}::uuid AND (${before ?? null}::bigint IS NULL OR revision < ${before ?? null}::bigint)
    ORDER BY revision DESC LIMIT 11
  `);
  const items = rows.rows.slice(0, 10).map((row) => responsibilitySchema.parse(row.document));
  return responsibilityHistorySchema.parse({
    items,
    next: rows.rows.length > 10 ? items.at(-1)?.revision : null,
  });
}
