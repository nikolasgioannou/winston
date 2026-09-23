import { sql } from "drizzle-orm";
import type { UserMessage } from "@winston/contracts/messages";
import type { TelegramUpdate } from "@winston/contracts/telegram";
import { telegramMedia } from "../telegram/media";
import type { DatabaseTransaction } from "./owners";

// Inbox ingestion already holds the owner lock and has persisted this exact message revision.
export async function reserveTelegramAttachment(
  transaction: DatabaseTransaction,
  ownerId: string,
  botId: number,
  update: TelegramUpdate,
  envelope: UserMessage,
) {
  const media = telegramMedia(update);
  const attachment = envelope.metadata.attachments[0];
  await transaction.execute(sql`
    UPDATE winston.telegram_intake SET state = 'canceled', lease_token = NULL, leased_until = NULL
    WHERE owner_id = ${ownerId}::uuid AND message_id = ${envelope.messageId}::uuid
      AND id IS DISTINCT FROM ${attachment?.id ?? null}::uuid AND state NOT IN ('failed', 'canceled')
  `);
  if (!media || !attachment || attachment.state !== "pending") return;
  await transaction.execute(sql`
    INSERT INTO winston.telegram_intake (owner_id, id, message_id, bot_id, file_id, filename, media_type, expected_size, voice)
    VALUES (${ownerId}::uuid, ${attachment.id}::uuid, ${envelope.messageId}::uuid, ${botId}, ${media.fileId},
      ${attachment.filename}, ${attachment.mediaType}, ${media.size ?? null}, ${media.voice})
    ON CONFLICT (owner_id, id) DO NOTHING
  `);
}
