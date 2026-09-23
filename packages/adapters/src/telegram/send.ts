import { telegramKeyboardSchema, type TelegramKeyboard } from "@winston/contracts/telegram";

import { telegramSendResult, type TelegramSendOutcome } from "./send-result";
export type { TelegramSendOutcome } from "./send-result";

export function createTelegramSender(token: string) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Telegram token is invalid.");

  return async (
    chatId: string,
    text: string,
    signal: AbortSignal,
    keyboard?: TelegramKeyboard,
  ): Promise<TelegramSendOutcome> => {
    if (signal.aborted) return { state: "retry", afterSeconds: 1 };
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          link_preview_options: { is_disabled: true },
          ...(keyboard ? { reply_markup: telegramKeyboardSchema.parse(keyboard) } : {}),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      return telegramSendResult(await response.json());
    } catch {
      // A timeout or broken connection after submission may still have delivered the message.
      return { state: "uncertain" };
    }
  };
}
