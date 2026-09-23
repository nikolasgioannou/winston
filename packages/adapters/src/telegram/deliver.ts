import type { OwnerTransaction } from "../database/database";
import type { TelegramSendOutcome } from "./send";
import type { TelegramKeyboard } from "@winston/contracts/telegram";

export async function deliverTelegramNext(
  database: {
    transaction<Result>(
      ownerId: string,
      work: (scope: OwnerTransaction) => Promise<Result>,
    ): Promise<Result>;
  },
  ownerId: string,
  botId: number,
  send: (
    chatId: string,
    text: string,
    signal: AbortSignal,
    keyboard?: TelegramKeyboard,
  ) => Promise<TelegramSendOutcome>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const delivery = await database.transaction(ownerId, ({ telegramOutbound }) =>
    telegramOutbound.claim(botId),
  );
  if (!delivery) return "idle";
  let outcome: TelegramSendOutcome;
  try {
    outcome = await send(delivery.chatId, delivery.text, signal, delivery.keyboard);
  } catch {
    outcome = { state: "uncertain" };
  }
  const settled = await database.transaction(ownerId, ({ telegramOutbound }) =>
    telegramOutbound.settle(delivery, outcome),
  );

  return settled ? outcome.state : "lease-lost";
}
