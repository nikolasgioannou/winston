export type TelegramSendOutcome =
  | { state: "sent"; messageId: number }
  | { state: "retry"; afterSeconds: number }
  | { state: "rejected" }
  | { state: "uncertain" };

export function createTelegramSender(token: string) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Telegram token is invalid.");

  return async (
    chatId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<TelegramSendOutcome> => {
    if (signal.aborted) return { state: "retry", afterSeconds: 1 };
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("ok" in body)) return { state: "uncertain" };
      if (
        body.ok === true &&
        "result" in body &&
        body.result &&
        typeof body.result === "object" &&
        "message_id" in body.result &&
        typeof body.result.message_id === "number" &&
        Number.isSafeInteger(body.result.message_id)
      ) {
        return { state: "sent", messageId: body.result.message_id };
      }
      if (
        body.ok === false &&
        "error_code" in body &&
        body.error_code === 429 &&
        "parameters" in body &&
        body.parameters &&
        typeof body.parameters === "object" &&
        "retry_after" in body.parameters &&
        typeof body.parameters.retry_after === "number" &&
        Number.isSafeInteger(body.parameters.retry_after) &&
        body.parameters.retry_after > 0
      ) {
        return { state: "retry", afterSeconds: body.parameters.retry_after };
      }
      if (
        body.ok === false &&
        "error_code" in body &&
        [400, 401, 403, 404].includes(Number(body.error_code))
      )
        return { state: "rejected" };

      return { state: "uncertain" };
    } catch {
      // A timeout or broken connection after submission may still have delivered the message.
      return { state: "uncertain" };
    }
  };
}
