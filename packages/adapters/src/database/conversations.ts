import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  acceptMessageRevision,
  serializeUserMessage,
  userMessageSchema,
  type UserMessage,
} from "@winston/contracts/messages";
import { telegramEventKeySchema, telegramUpdateSchema } from "@winston/contracts/telegram";
import { telegramEnvelope } from "../telegram/envelope";
import type { DatabaseTransaction } from "./owners";
import { eventRepository } from "./events";
import { taskRepository } from "./tasks";
import { taskResourceRepository } from "./task-resources";
import { taskUpdateRepository } from "./task-updates";

type Conversation = {
  id: string;
  revision: number;
  responseRevision: number;
  inputRevision: number;
};
type MessageRow = {
  envelope: unknown;
  sourceUpdateId: string;
  mediaGroupId: string | null;
  conversationRevision: number;
};

export function conversationRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    // Use the same lock order as ingress: owner, then conversation. No network work under locks.
    const owner = await transaction.execute(sql`
      SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE
    `);
    if (!owner.rowCount) throw new Error("Owner profile is missing.");

    await transaction.execute(sql`
      INSERT INTO winston.conversations (owner_id, id) VALUES (${ownerId}::uuid, ${randomUUID()}::uuid)
      ON CONFLICT DO NOTHING
    `);
    const result = await transaction.execute<Conversation>(sql`
      SELECT id, revision, response_revision AS "responseRevision", input_revision AS "inputRevision"
      FROM winston.conversations WHERE owner_id = ${ownerId}::uuid FOR UPDATE
    `);
    const conversation = result.rows[0];
    if (!conversation) throw new Error("Conversation is unavailable.");

    return conversation;
  }

  async function pending() {
    const result = await transaction.execute(sql`
      SELECT 1 FROM winston.events e WHERE e.owner_id = ${ownerId}::uuid
        AND e.type IN ('telegram.message-received', 'telegram.message-edited')
        AND NOT EXISTS (
          SELECT 1 FROM winston.event_receipts r WHERE r.owner_id = e.owner_id
            AND r.event_id = e.id AND r.consumer = 'conversation-inbox'
        ) LIMIT 1
    `);

    return Boolean(result.rowCount);
  }

  return {
    async admitTaskUpdates() {
      const conversation = await lock();
      if (conversation.responseRevision < conversation.inputRevision || (await pending()))
        return false;
      const outgoing = await transaction.execute(sql`
        SELECT 1 FROM winston.telegram_outbound WHERE owner_id = ${ownerId}::uuid
          AND state IN ('pending', 'sending', 'uncertain') LIMIT 1
      `);
      if (outgoing.rowCount || !(await taskUpdateRepository(transaction, ownerId).pending()).length)
        return false;
      await transaction.execute(sql`
        UPDATE winston.conversations SET revision = revision + 1, input_revision = revision + 1,
          collect_until = NULL, burst_started_at = NULL WHERE owner_id = ${ownerId}::uuid
      `);
      return true;
    },
    async status() {
      const conversation = await lock();
      const result = await transaction.execute<{ ready: boolean }>(sql`
        SELECT COALESCE(collect_until <= clock_timestamp(), true) AS ready
        FROM winston.conversations WHERE owner_id = ${ownerId}::uuid
      `);
      return { ...conversation, pending: await pending(), ready: result.rows[0]?.ready === true };
    },
    async consumeTelegram(eventId: string) {
      const conversation = await lock();

      return eventRepository(transaction, ownerId).consume(
        eventId,
        "conversation-inbox",
        async (event) => {
          if (!["telegram.message-received", "telegram.message-edited"].includes(event.type))
            throw new Error("Unsupported inbox event.");
          const key = telegramEventKeySchema.parse(event.payload);
          const updates = await transaction.execute<{ payload: unknown }>(sql`
          SELECT payload FROM winston.telegram_updates WHERE owner_id = ${ownerId}::uuid
            AND bot_id = ${key.botId} AND update_id = ${key.updateId}
        `);
          const incoming = telegramUpdateSchema.parse(updates.rows[0]?.payload);
          const message = incoming.message ?? incoming.edited_message;
          if (!message) throw new Error("Inbox update has no message.");

          // Read all known revisions so delivery order cannot roll an edit back to its original text.
          const revisions = await transaction.execute<{
            payload: unknown;
            snapshot: UserMessage["sentAt"];
            updateId: string;
          }>(sql`
          SELECT payload, timezone_snapshot AS snapshot, update_id::text AS "updateId"
          FROM winston.telegram_updates WHERE owner_id = ${ownerId}::uuid AND bot_id = ${key.botId}
            AND COALESCE(payload->'message', payload->'edited_message')->>'message_id' = ${String(message.message_id)}
            AND COALESCE(payload->'message', payload->'edited_message')->'chat'->>'id' = ${String(message.chat.id)}
          ORDER BY received_at, update_id
        `);
          const first = revisions.rows[0];
          if (!first) throw new Error("Inbox receipt is unavailable.");
          const candidates = revisions.rows.map((row) => ({
            ...row,
            update: telegramUpdateSchema.parse(row.payload),
          }));
          candidates.sort((a, b) => {
            const aMessage = a.update.edited_message ?? a.update.message;
            const bMessage = b.update.edited_message ?? b.update.message;

            return (
              (bMessage?.edit_date ?? 0) - (aMessage?.edit_date ?? 0) ||
              Number(b.updateId) - Number(a.updateId)
            );
          });
          const latest = candidates[0];
          if (!latest) throw new Error("Inbox revision is unavailable.");
          const existing = await transaction.execute<MessageRow>(sql`
          SELECT envelope, source_update_id::text AS "sourceUpdateId", media_group_id AS "mediaGroupId"
          FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid
            AND bot_id = ${key.botId} AND chat_id = ${message.chat.id} AND provider_message_id = ${message.message_id}
        `);
          const current = existing.rows[0];
          if (current?.sourceUpdateId === latest.updateId) return;

          const envelope = telegramEnvelope({
            update: latest.update,
            ownerId,
            conversationId: conversation.id,
            sentAt: first.snapshot,
            ...(current ? { current: userMessageSchema.parse(current.envelope) } : {}),
          });
          await transaction.execute(sql`
          INSERT INTO winston.conversation_messages
            (owner_id, id, bot_id, chat_id, provider_message_id, provider_sent_at, source_update_id, media_group_id, envelope, conversation_revision)
          VALUES (${ownerId}::uuid, ${envelope.messageId}::uuid, ${key.botId}, ${message.chat.id}, ${message.message_id},
            ${envelope.provider.sentAt}::timestamptz, ${latest.updateId}::bigint, ${message.media_group_id ?? null}, ${JSON.stringify(envelope)}::jsonb, ${conversation.revision + 1})
          ON CONFLICT (owner_id, bot_id, chat_id, provider_message_id)
          DO UPDATE SET source_update_id = EXCLUDED.source_update_id, envelope = EXCLUDED.envelope, conversation_revision = EXCLUDED.conversation_revision
        `);
          await transaction.execute(sql`
          UPDATE winston.conversations SET revision = revision + 1, input_revision = revision + 1,
            burst_started_at = CASE WHEN response_revision >= input_revision THEN clock_timestamp()
              ELSE COALESCE(burst_started_at, clock_timestamp()) END,
            collect_until = CASE WHEN response_revision >= input_revision THEN clock_timestamp() + interval '120 milliseconds'
              ELSE LEAST(COALESCE(burst_started_at, clock_timestamp()) + interval '600 milliseconds', clock_timestamp() + interval '240 milliseconds') END
          WHERE owner_id = ${ownerId}::uuid
        `);
        },
      );
    },
    async snapshot(limit: number) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
        throw new Error("Conversation window must contain between 1 and 10000 messages.");
      const conversation = await lock();
      const rows = await transaction.execute<MessageRow>(sql`
        SELECT envelope, source_update_id::text AS "sourceUpdateId", media_group_id AS "mediaGroupId", conversation_revision AS "conversationRevision"
        FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid
        ORDER BY provider_sent_at DESC, bot_id DESC, chat_id DESC, provider_message_id DESC LIMIT ${limit}
      `);
      const messages = rows.rows.reverse().map((row) => {
        const envelope = userMessageSchema.parse(row.envelope);

        return {
          envelope,
          content: serializeUserMessage(envelope),
          mediaGroupId: row.mediaGroupId,
          conversationRevision: row.conversationRevision,
        };
      });

      const activeTasks = await taskRepository(transaction, ownerId).listActive();
      return {
        ...conversation,
        pending: await pending(),
        messages,
        activeTasks,
        taskUpdates: await taskUpdateRepository(transaction, ownerId).pending(),
        taskResources: await taskResourceRepository(transaction, ownerId).context(
          activeTasks.map((task) => task.id),
        ),
      };
    },
    // Trusted staging/transcription services call this after verifying their output. No owner HTTP endpoint.
    async resolveMessage(nextInput: UserMessage) {
      const conversation = await lock();
      const next = userMessageSchema.parse(nextInput);
      if (next.ownerId !== ownerId || next.metadata.references.some((ref) => ref.kind !== "task"))
        throw new Error("Message references require an authorized resolver.");
      await taskResourceRepository(transaction, ownerId).validateReferences(
        next.messageId,
        next.metadata.references.map((ref) => ref.id),
      );
      const result = await transaction.execute<{ envelope: unknown }>(sql`
        SELECT envelope FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid AND id = ${next.messageId}::uuid
      `);
      const current = userMessageSchema.parse(result.rows[0]?.envelope);
      const accepted = acceptMessageRevision(current, next);
      if (accepted.revision === current.revision) return false;

      await transaction.execute(sql`
        UPDATE winston.conversation_messages SET envelope = ${JSON.stringify(accepted)}::jsonb, conversation_revision = ${conversation.revision + 1}
        WHERE owner_id = ${ownerId}::uuid AND id = ${next.messageId}::uuid
      `);
      await transaction.execute(sql`
        UPDATE winston.conversations SET revision = revision + 1, input_revision = revision + 1 WHERE owner_id = ${ownerId}::uuid
      `);

      return true;
    },
    // Call within the same transaction that publishes the corresponding durable response intent.
    async markResponded(revision: number) {
      const conversation = await lock();
      if (
        conversation.revision !== revision ||
        conversation.responseRevision >= revision ||
        (await pending())
      )
        return false;

      await transaction.execute(sql`
        UPDATE winston.conversations SET response_revision = ${revision} WHERE owner_id = ${ownerId}::uuid
      `);

      return true;
    },
  };
}

export type ConversationRepository = ReturnType<typeof conversationRepository>;
