import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { splitTelegramText } from "../telegram/text";
import type { TelegramSendOutcome } from "../telegram/send";
import type { DatabaseTransaction } from "./owners";
import { telegramKeyboardSchema, type TelegramKeyboard } from "@winston/contracts/telegram";

type OutboundRow = {
  id: string;
  chatId: string;
  botId: string;
  parts: string[];
  nextPart: number;
  sentIds: number[];
  state: "pending" | "sending" | "uncertain" | "delivered" | "failed" | "canceled";
  leaseToken: string | null;
  expired: boolean;
  available: boolean;
  keyboard: unknown;
};
export type TelegramDelivery = {
  id: string;
  token: string;
  chatId: string;
  text: string;
  keyboard?: TelegramKeyboard;
};

export function telegramOutboundRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    const result = await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
    if (!result.rowCount) throw new Error("Owner is unavailable.");
  }

  const fields = sql`id, chat_id::text AS "chatId", bot_id::text AS "botId", parts,
    next_part AS "nextPart", sent_ids AS "sentIds", state, lease_token AS "leaseToken", reply_markup AS keyboard,
    COALESCE(leased_until <= clock_timestamp(), true) AS expired, available_at <= clock_timestamp() AS available`;

  return {
    async enqueue(key: string, botId: number, text: string, inputKeyboard?: TelegramKeyboard) {
      if (!key || key.length > 200 || !Number.isSafeInteger(botId))
        throw new Error("Invalid outbound identity.");
      const parts = splitTelegramText(text);
      const keyboard =
        inputKeyboard === undefined ? null : telegramKeyboardSchema.parse(inputKeyboard);
      await lock();
      const existing = await transaction.execute<OutboundRow>(sql`
        SELECT ${fields} FROM winston.telegram_outbound WHERE owner_id = ${ownerId}::uuid AND request_key = ${key}
      `);
      if (existing.rows[0]) {
        if (
          existing.rows[0].botId !== String(botId) ||
          !isDeepStrictEqual(parts, existing.rows[0].parts) ||
          !isDeepStrictEqual(keyboard, existing.rows[0].keyboard)
        )
          throw new Error("Outbound key conflicts with its original message.");
        return existing.rows[0].id;
      }
      const binding = await transaction.execute<{ chatId: string }>(sql`
        SELECT chat_id::text AS "chatId" FROM winston.telegram_bindings WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId}
      `);
      const chatId = binding.rows[0]?.chatId;
      if (!chatId) throw new Error("Telegram is not paired.");
      const id = randomUUID();
      await transaction.execute(sql`
        INSERT INTO winston.telegram_outbound (owner_id, id, request_key, bot_id, chat_id, parts, reply_markup)
        VALUES (${ownerId}::uuid, ${id}::uuid, ${key}, ${botId}, ${chatId}::bigint, ${JSON.stringify(parts)}::jsonb, ${keyboard === null ? null : JSON.stringify(keyboard)}::jsonb)
      `);

      return id;
    },
    async find(id: string) {
      const result = await transaction.execute<OutboundRow>(sql`
        SELECT ${fields} FROM winston.telegram_outbound WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
      `);

      return result.rows[0];
    },
    async claim(botId: number): Promise<TelegramDelivery | undefined> {
      await lock();
      const result = await transaction.execute<OutboundRow>(sql`
        SELECT ${fields} FROM winston.telegram_outbound WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId}
          AND state IN ('pending', 'sending', 'uncertain') ORDER BY sequence LIMIT 1 FOR UPDATE
      `);
      const row = result.rows[0];
      if (!row || row.state === "uncertain" || !row.available) return undefined;
      if (row.state === "sending") {
        if (row.expired)
          await transaction.execute(sql`
          UPDATE winston.telegram_outbound SET state = 'uncertain' WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
        `);
        return undefined;
      }
      // A reply that has not begun delivery can still yield to newly arrived input.
      // Once a part is acknowledged, preserve the remainder of that same response.
      if (row.nextPart === 0) {
        const stale = await transaction.execute(sql`
          SELECT 1 FROM winston.conversation_turns t
          JOIN winston.conversations c ON c.owner_id = t.owner_id
          WHERE t.owner_id = ${ownerId}::uuid AND t.response_id = ${row.id}::uuid AND (
            c.input_revision > t.revision OR EXISTS (
              SELECT 1 FROM winston.events e WHERE e.owner_id = t.owner_id
                AND e.type IN ('telegram.message-received', 'telegram.message-edited')
                AND NOT EXISTS (SELECT 1 FROM winston.event_receipts r WHERE r.owner_id = e.owner_id
                  AND r.event_id = e.id AND r.consumer = 'conversation-inbox')
            )
          )
        `);
        if (stale.rowCount) {
          await transaction.execute(sql`
            UPDATE winston.telegram_outbound SET state = 'canceled'
            WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
          `);
          return undefined;
        }
      }
      const binding = await transaction.execute(sql`
        SELECT 1 FROM winston.telegram_bindings WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId} AND chat_id = ${row.chatId}::bigint
      `);
      if (!binding.rowCount) {
        await transaction.execute(sql`
          UPDATE winston.telegram_outbound SET state = 'canceled' WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
        `);
        return undefined;
      }
      const token = randomUUID();
      const text = row.parts[row.nextPart];
      if (!text) throw new Error("Outbound message part is unavailable.");
      await transaction.execute(sql`
        UPDATE winston.telegram_outbound SET state = 'sending', lease_token = ${token}::uuid,
          leased_until = clock_timestamp() + interval '45 seconds'
        WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
      `);

      return {
        id: row.id,
        token,
        chatId: row.chatId,
        text,
        ...(row.keyboard !== null && row.nextPart === row.parts.length - 1
          ? { keyboard: telegramKeyboardSchema.parse(row.keyboard) }
          : {}),
      };
    },
    async settle(delivery: TelegramDelivery, outcome: TelegramSendOutcome) {
      await lock();
      const result = await transaction.execute<OutboundRow>(sql`
        SELECT ${fields} FROM winston.telegram_outbound WHERE owner_id = ${ownerId}::uuid AND id = ${delivery.id}::uuid FOR UPDATE
      `);
      const row = result.rows[0];
      if (
        !row ||
        !["sending", "uncertain"].includes(row.state) ||
        row.leaseToken !== delivery.token
      )
        return false;
      const sentIds = outcome.state === "sent" ? [...row.sentIds, outcome.messageId] : row.sentIds;
      const nextPart = outcome.state === "sent" ? row.nextPart + 1 : row.nextPart;
      let state: OutboundRow["state"] = "uncertain";
      if (outcome.state === "sent") state = nextPart === row.parts.length ? "delivered" : "pending";
      if (outcome.state === "retry") state = "pending";
      if (outcome.state === "rejected") state = "failed";
      const delay =
        outcome.state === "retry" ? Math.max(1, Math.min(outcome.afterSeconds, 86_400)) : 0;
      await transaction.execute(sql`
        UPDATE winston.telegram_outbound SET state = ${state}, next_part = ${nextPart}, sent_ids = ${JSON.stringify(sentIds)}::jsonb,
          lease_token = ${state === "uncertain" ? delivery.token : null}::uuid, leased_until = NULL,
          available_at = clock_timestamp() + ${delay} * interval '1 second'
        WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
      `);

      return true;
    },
    // An operator may abandon an uncertain send, but it is never silently retried.
    async abandon(id: string) {
      await lock();
      const result = await transaction.execute(sql`
        UPDATE winston.telegram_outbound SET state = 'failed', lease_token = NULL, leased_until = NULL
        WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid AND state = 'uncertain' RETURNING id
      `);

      return Boolean(result.rowCount);
    },
  };
}

export type TelegramOutboundRepository = ReturnType<typeof telegramOutboundRepository>;
