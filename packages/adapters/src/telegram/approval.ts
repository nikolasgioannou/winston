import { sql } from "drizzle-orm";
import type { TelegramCallbackQuery } from "@winston/contracts/telegram";
import type { DatabaseTransaction } from "../database/owners";
import { telegramApprovalRepository } from "../database/telegram-approvals";

export async function receiveTelegramApproval(
  transaction: DatabaseTransaction,
  botId: number,
  query: TelegramCallbackQuery,
) {
  const invalid = { callbackId: query.id, text: "This approval is no longer available." };
  const message = query.message;
  if (
    query.from.is_bot ||
    !message ||
    !query.data ||
    message.date === 0 ||
    message.chat.type !== "private" ||
    message.chat.id !== query.from.id ||
    !message.from?.is_bot ||
    message.from.id !== botId
  )
    return invalid;
  const bindings = await transaction.execute<{ ownerId: string }>(sql`
    SELECT owner_id AS "ownerId" FROM winston.telegram_bindings
    WHERE bot_id = ${botId} AND user_id = ${query.from.id} AND chat_id = ${message.chat.id}
  `);
  const ownerId = bindings.rows[0]?.ownerId;
  if (!ownerId) return invalid;
  const result = await telegramApprovalRepository(transaction, ownerId).decide({
    botId,
    userId: query.from.id,
    chatId: message.chat.id,
    messageId: message.message_id,
    token: query.data,
  });
  if (!result || result.state === "invalidated") return invalid;
  return {
    callbackId: query.id,
    text:
      result.state === "approved"
        ? result.duplicate
          ? "Already approved."
          : "Approved."
        : result.duplicate
          ? "Already rejected."
          : "Rejected.",
  };
}
