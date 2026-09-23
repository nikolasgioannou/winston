import { timingSafeEqual } from "node:crypto";
import { telegramBotSchema, telegramUpdateSchema } from "@winston/contracts/telegram";
export { createTelegramStore, type TelegramStore } from "./store";
export { createTelegramSender, type TelegramSendOutcome } from "./send";
export { splitTelegramText } from "./text";
export { deliverTelegramNext } from "./deliver";
export { deliverTelegramFile } from "./deliver-file";
export { intakeTelegramFile } from "./intake";
export {
  createTelegramDownloader,
  TelegramDownloadError,
  maximumTelegramDownloadBytes,
} from "./download";
export {
  createTelegramDocumentSender,
  maximumTelegramDocumentBytes,
  type TelegramDocument,
} from "./document";

export function verifyTelegramWebhook(actual: string | null, expected: string) {
  if (!actual || !expected) return false;
  const supplied = Buffer.from(actual);
  const secret = Buffer.from(expected);

  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}

export function createTelegramClient(token: string) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Telegram token is invalid.");

  async function call(method: string, body: Record<string, unknown>, signal: AbortSignal) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const result: unknown = await response.json();

      if (
        !response.ok ||
        !result ||
        typeof result !== "object" ||
        !("ok" in result) ||
        result.ok !== true ||
        !("result" in result)
      ) {
        throw new Error("Telegram rejected the request.");
      }

      return result.result;
    } catch {
      // Fetch errors may contain the credential-bearing URL. Never propagate them.
      throw new Error(signal.aborted ? "Telegram request cancelled." : "Telegram request failed.");
    }
  }

  return {
    async answerCallback(id: string, text: string) {
      await call(
        "answerCallbackQuery",
        { callback_query_id: id, text: text.slice(0, 200) },
        AbortSignal.timeout(3000),
      );
    },
    async identity() {
      return telegramBotSchema.parse(await call("getMe", {}, AbortSignal.timeout(10_000)));
    },
    async updates(offset: number | undefined, signal: AbortSignal) {
      const updates = await call(
        "getUpdates",
        {
          offset,
          timeout: 25,
          allowed_updates: ["message", "edited_message", "callback_query"],
        },
        AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      );

      if (!Array.isArray(updates)) throw new Error("Invalid Telegram update response.");

      return updates.map((update: unknown) => telegramUpdateSchema.parse(update));
    },
  };
}
