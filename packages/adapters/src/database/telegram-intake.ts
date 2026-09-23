import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { userMessageSchema } from "@winston/contracts/messages";
import { telegramUpdateSchema } from "@winston/contracts/telegram";
import type { DatabaseTransaction } from "./owners";
import { reserveTelegramAttachment } from "./telegram-intake-reservation";
import { conversationRepository } from "./conversations";
import { artifactRepository } from "./artifacts";

type IntakeRow = {
  id: string;
  messageId: string;
  botId: number;
  fileId: string;
  filename: string;
  mediaType: string;
  expectedSize: string | null;
  voice: boolean;
  state: "pending" | "downloading" | "stored" | "staged" | "failed" | "canceled";
  artifactId: string | null;
  token: string | null;
  expired: boolean;
  attempts: number;
};
export type TelegramIntake = Omit<IntakeRow, "token"> & { token: string };
const reasons = {
  too_large: "This file is too large to download from Telegram.",
  download_failed: "This file could not be downloaded. Please send it again.",
} as const;

export function telegramIntakeRepository(transaction: DatabaseTransaction, ownerId: string) {
  const fields = sql`id, message_id AS "messageId", bot_id::float8 AS "botId", file_id AS "fileId", filename, media_type AS "mediaType",
    expected_size::text AS "expectedSize", voice, state, artifact_id AS "artifactId", lease_token AS token,
    COALESCE(leased_until <= clock_timestamp(), true) AS expired, attempts`;
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }
  async function find(id: string) {
    userMessageSchema.shape.messageId.parse(id);
    const rows = await transaction.execute<IntakeRow>(sql`
      SELECT ${fields} FROM winston.telegram_intake WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
    `);
    return rows.rows[0];
  }
  async function message(row: IntakeRow) {
    const rows = await transaction.execute<{ envelope: unknown }>(sql`
      SELECT m.envelope FROM winston.conversation_messages m JOIN winston.telegram_bindings b
        ON b.owner_id = m.owner_id AND b.bot_id = m.bot_id AND b.chat_id = m.chat_id
      WHERE m.owner_id = ${ownerId}::uuid AND m.id = ${row.messageId}::uuid
    `);
    const result = rows.rows[0] ? userMessageSchema.parse(rows.rows[0].envelope) : null;
    return result?.metadata.attachments.some(
      (attachment) => attachment.id === row.id && attachment.state === "pending",
    )
      ? result
      : null;
  }
  async function fail(row: IntakeRow, reason: keyof typeof reasons) {
    const current = await message(row);
    await transaction.execute(sql`
      UPDATE winston.telegram_intake SET state = ${current ? "failed" : "canceled"}, lease_token = NULL, leased_until = NULL
      WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
    `);
    if (!current) return false;
    await conversationRepository(transaction, ownerId).resolveMessage({
      ...current,
      revision: current.revision + 1,
      metadata: {
        ...current.metadata,
        ...(current.metadata.transcript?.attachmentId === row.id &&
        current.metadata.transcript.state === "pending"
          ? {
              transcript: {
                state: "failed" as const,
                attachmentId: row.id,
                reason: reasons[reason],
              },
            }
          : {}),
        attachments: current.metadata.attachments.map((attachment) =>
          attachment.id === row.id
            ? {
                id: attachment.id,
                filename: attachment.filename,
                mediaType: attachment.mediaType,
                state: "failed",
                reason: reasons[reason],
              }
            : attachment,
        ),
      },
    });
    return true;
  }
  async function current(input: TelegramIntake) {
    await lock();
    const row = await find(input.id);
    return row?.state === "downloading" && row.token === input.token && !row.expired ? row : null;
  }
  return {
    find,
    async active(input: TelegramIntake) {
      const row = await current(input);
      return Boolean(row && (await message(row)));
    },
    async discover(botId: number) {
      await lock();
      const rows = await transaction.execute<{ envelope: unknown; payload: unknown }>(sql`
        SELECT m.envelope, u.payload FROM winston.conversation_messages m JOIN winston.telegram_updates u
          ON u.owner_id = m.owner_id AND u.bot_id = m.bot_id AND u.update_id = m.source_update_id
        WHERE m.owner_id = ${ownerId}::uuid AND m.bot_id = ${botId}
          AND m.envelope->'metadata'->'attachments'->0->>'state' = 'pending'
          AND NOT EXISTS (SELECT 1 FROM winston.telegram_intake i WHERE i.owner_id = m.owner_id AND i.id::text = m.envelope->'metadata'->'attachments'->0->>'id')
        ORDER BY m.provider_sent_at, m.id LIMIT 100
      `);
      for (const row of rows.rows)
        await reserveTelegramAttachment(
          transaction,
          ownerId,
          botId,
          telegramUpdateSchema.parse(row.payload),
          userMessageSchema.parse(row.envelope),
        );
      return rows.rows.length;
    },
    async claim(botId: number): Promise<TelegramIntake | undefined> {
      await lock();
      const rows = await transaction.execute<IntakeRow>(sql`
        SELECT ${fields} FROM winston.telegram_intake WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId}
          AND available_at <= clock_timestamp() AND (state = 'pending' OR (state = 'downloading' AND leased_until <= clock_timestamp()))
        ORDER BY created_at, id LIMIT 1 FOR UPDATE
      `);
      const row = rows.rows[0];
      if (!row) return undefined;
      if (row.attempts >= 5 || !(await message(row))) {
        await fail(row, "download_failed");
        return undefined;
      }
      const token = randomUUID();
      await transaction.execute(sql`
        UPDATE winston.telegram_intake SET state = 'downloading', attempts = attempts + 1, lease_token = ${token}::uuid,
          leased_until = clock_timestamp() + interval '180 seconds' WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
      `);
      return { ...row, state: "downloading", token, expired: false, attempts: row.attempts + 1 };
    },
    async retry(input: TelegramIntake) {
      const row = await current(input);
      if (!row) return false;
      await transaction.execute(sql`
        UPDATE winston.telegram_intake SET state = 'pending', lease_token = NULL, leased_until = NULL,
          available_at = clock_timestamp() + ${Math.min(60, row.attempts * 5)} * interval '1 second'
        WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
      `);
      return true;
    },
    async fail(input: TelegramIntake, reason: keyof typeof reasons) {
      const row = await current(input);
      return row ? fail(row, reason) : false;
    },
    async stored(input: TelegramIntake, artifactId: string) {
      const row = await current(input);
      if (!row || !(await message(row))) return false;
      const artifact = await artifactRepository(transaction, ownerId).find(artifactId);
      if (
        artifact?.state !== "ready" ||
        artifact.metadata.source.kind !== "telegram" ||
        artifact.metadata.source.reference !== `message:${row.messageId}/attachment:${row.id}`
      )
        return false;
      await transaction.execute(sql`
        UPDATE winston.telegram_intake SET state = 'stored', artifact_id = ${artifactId}::uuid, lease_token = NULL, leased_until = NULL
        WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
      `);
      return true;
    },
  };
}
