import { sql } from "drizzle-orm";
import { userMessageSchema } from "@winston/contracts/messages";
import {
  responsibilityHistorySchema,
  responsibilitySourcesSchema,
  responsibilitySchema,
  type Responsibility,
} from "@winston/contracts/responsibilities";
import type { DatabaseTransaction } from "./owners";

export async function responsibilitySources(
  transaction: DatabaseTransaction,
  ownerId: string,
  responsibility: Responsibility,
) {
  const rows = await transaction.execute<{ id: string; envelope: unknown }>(sql`
    SELECT id, envelope FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid
      AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(responsibility.sources.map((source) => source.messageId))}::jsonb)::uuid)
  `);
  const messages = new Map(rows.rows.map((row) => [row.id, userMessageSchema.parse(row.envelope)]));
  return responsibilitySourcesSchema.parse({
    id: responsibility.id,
    revision: responsibility.revision,
    items: responsibility.sources.map((source) => {
      const message = messages.get(source.messageId);
      if (!message) return { ...source, status: "unavailable" };
      if (message.revision !== source.revision) return { ...source, status: "changed" };
      const transcript =
        message.metadata.transcript?.state === "ready" ? message.metadata.transcript.text : null;
      return {
        ...source,
        status: "current",
        kind: message.input.kind,
        text: message.input.text.slice(0, 4000),
        transcript: transcript?.slice(0, 4000) ?? null,
        truncated: message.input.text.length > 4000 || (transcript?.length ?? 0) > 4000,
        sentAt: message.sentAt,
      };
    }),
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
