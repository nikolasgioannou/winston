import { artifactMetadataSchema } from "@winston/contracts/artifacts";
import { telegramSendResult, type TelegramSendOutcome } from "./send-result";

export const maximumTelegramDocumentBytes = 50_000_000;
export type TelegramDocument = {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  caption?: string;
};

// Only trusted delivery workers call this with owner-bound, verified artifact bytes.
export function createTelegramDocumentSender(token: string) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Telegram token is invalid.");

  return async (
    chatId: string,
    document: TelegramDocument,
    signal: AbortSignal,
  ): Promise<TelegramSendOutcome> => {
    if (signal.aborted) return { state: "retry", afterSeconds: 1 };
    if (
      !/^\d+$/.test(chatId) ||
      !artifactMetadataSchema.shape.name.safeParse(document.name).success ||
      document.bytes.byteLength === 0 ||
      document.bytes.byteLength > maximumTelegramDocumentBytes ||
      (document.caption?.length ?? 0) > 1024
    )
      return { state: "rejected" };

    const body = new FormData();
    body.set("chat_id", chatId);
    body.set(
      "document",
      new Blob([document.bytes], { type: "application/octet-stream" }),
      document.name,
    );
    body.set("disable_content_type_detection", "true");
    if (document.caption) body.set("caption", document.caption);
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: "POST",
        redirect: "error",
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      });
      return telegramSendResult(await response.json());
    } catch {
      // Do not leak credential-bearing URLs or retry a possibly delivered document.
      return { state: "uncertain" };
    }
  };
}
