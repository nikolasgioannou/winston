import { sql } from "drizzle-orm";
import { messageSourceSchema, userMessageSchema } from "@winston/contracts/messages";
import type { DatabaseTransaction } from "./owners";

export async function messageSources(
  transaction: DatabaseTransaction,
  ownerId: string,
  sources: { messageId: string; revision: number | null }[],
) {
  const rows = await transaction.execute<{ id: string; envelope: unknown }>(sql`
    SELECT id, envelope FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid
      AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(sources.filter((source) => source.revision !== null).map((source) => source.messageId))}::jsonb)::uuid)
  `);
  const messages = new Map(rows.rows.map((row) => [row.id, userMessageSchema.parse(row.envelope)]));
  return sources.map((source) => {
    if (source.revision === null)
      return messageSourceSchema.parse({ ...source, status: "uncaptured" });
    const message = messages.get(source.messageId);
    if (!message) return messageSourceSchema.parse({ ...source, status: "unavailable" });
    if (message.revision !== source.revision)
      return messageSourceSchema.parse({ ...source, status: "changed" });
    const transcript =
      message.metadata.transcript?.state === "ready" ? message.metadata.transcript.text : null;
    return messageSourceSchema.parse({
      ...source,
      status: "current",
      kind: message.input.kind,
      text: message.input.text.slice(0, 4000),
      transcript: transcript?.slice(0, 4000) ?? null,
      truncated: message.input.text.length > 4000 || (transcript?.length ?? 0) > 4000,
      sentAt: message.sentAt,
    });
  });
}
