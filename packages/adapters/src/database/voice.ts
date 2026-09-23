import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { userMessageSchema } from "@winston/contracts/messages";
import type { DatabaseTransaction } from "./owners";
import { conversationRepository } from "./conversations";

export type VoiceLease = { id: string; artifactId: string; token: string };

export function voiceRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }
  async function message(id: string) {
    const rows = await transaction.execute<{ envelope: unknown }>(sql`
      SELECT m.envelope FROM winston.telegram_intake i JOIN winston.conversation_messages m
        ON m.owner_id = i.owner_id AND m.id = i.message_id
      JOIN winston.telegram_bindings b ON b.owner_id = m.owner_id AND b.bot_id = m.bot_id AND b.chat_id = m.chat_id
      WHERE i.owner_id = ${ownerId}::uuid AND i.id = ${id}::uuid AND i.voice AND i.state IN ('stored', 'staged')
    `);
    const row = rows.rows[0];
    if (!row) return null;
    const result = userMessageSchema.parse(row.envelope);
    return result.metadata.transcript?.state === "pending" &&
      result.metadata.transcript.attachmentId === id
      ? result
      : null;
  }
  async function current(input: VoiceLease) {
    await lock();
    const rows = await transaction.execute(sql`
      SELECT id FROM winston.telegram_intake WHERE owner_id = ${ownerId}::uuid AND id = ${input.id}::uuid
        AND artifact_id = ${input.artifactId}::uuid AND voice_token = ${input.token}::uuid AND voice_leased_until > clock_timestamp()
    `);
    return rows.rowCount === 1 ? message(input.id) : null;
  }
  async function resolve(
    id: string,
    transcript:
      | { state: "failed"; reason: string }
      | { state: "ready"; text: string; provider: string; model: string; completedAt: string },
  ) {
    const original = await message(id);
    if (!original) return false;
    const changed = await conversationRepository(transaction, ownerId).resolveMessage({
      ...original,
      revision: original.revision + 1,
      metadata: { ...original.metadata, transcript: { ...transcript, attachmentId: id } },
    });
    await transaction.execute(sql`UPDATE winston.telegram_intake SET voice_token = NULL, voice_leased_until = NULL, voice_resolved_at = clock_timestamp()
      WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid`);
    return changed;
  }
  return {
    async claim(botId: number): Promise<VoiceLease | null> {
      await lock();
      const rows = await transaction.execute<{
        id: string;
        artifactId: string;
        attempts: number;
      }>(sql`
        SELECT i.id, i.artifact_id AS "artifactId", i.voice_attempts AS attempts FROM winston.telegram_intake i
        JOIN winston.conversation_messages m ON m.owner_id = i.owner_id AND m.id = i.message_id
        JOIN winston.telegram_bindings b ON b.owner_id = m.owner_id AND b.bot_id = m.bot_id AND b.chat_id = m.chat_id
        WHERE i.owner_id = ${ownerId}::uuid AND i.bot_id = ${botId} AND i.voice AND i.state IN ('stored', 'staged')
          AND i.artifact_id IS NOT NULL AND i.voice_resolved_at IS NULL AND i.voice_available_at <= clock_timestamp()
          AND (i.voice_leased_until IS NULL OR i.voice_leased_until <= clock_timestamp())
          AND m.envelope->'metadata'->'transcript'->>'state' = 'pending'
          AND m.envelope->'metadata'->'transcript'->>'attachmentId' = i.id::text
        ORDER BY i.created_at, i.id LIMIT 1
      `);
      const row = rows.rows[0];
      if (!row) return null;
      if (row.attempts >= 3) {
        await resolve(row.id, {
          state: "failed",
          reason:
            "This voice note could not be transcribed. Please send it again or type your message.",
        });
        return null;
      }
      const token = randomUUID();
      await transaction.execute(sql`UPDATE winston.telegram_intake SET voice_token = ${token}::uuid,
        voice_attempts = voice_attempts + 1, voice_leased_until = clock_timestamp() + interval '180 seconds'
        WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid`);
      return { id: row.id, artifactId: row.artifactId, token };
    },
    async active(input: VoiceLease) {
      return Boolean(await current(input));
    },
    async retry(input: VoiceLease) {
      if (!(await current(input))) return false;
      await transaction.execute(sql`UPDATE winston.telegram_intake SET voice_token = NULL, voice_leased_until = NULL,
        voice_available_at = clock_timestamp() + interval '5 seconds' WHERE owner_id = ${ownerId}::uuid AND id = ${input.id}::uuid`);
      return true;
    },
    async fail(input: VoiceLease) {
      if (!(await current(input))) return false;
      return resolve(input.id, {
        state: "failed",
        reason:
          "This voice note could not be transcribed. Please send it again or type your message.",
      });
    },
    async complete(input: VoiceLease, result: { text: string; provider: string; model: string }) {
      if (!(await current(input))) return false;
      return resolve(input.id, {
        state: "ready",
        ...result,
        completedAt: new Date().toISOString(),
      });
    },
  };
}
