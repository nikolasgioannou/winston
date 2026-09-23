export type TelegramSendOutcome =
  | { state: "sent"; messageId: number }
  | { state: "retry"; afterSeconds: number }
  | { state: "rejected" }
  | { state: "uncertain" };

export function telegramSendResult(body: unknown): TelegramSendOutcome {
  if (!body || typeof body !== "object" || !("ok" in body)) return { state: "uncertain" };
  if (
    body.ok === true &&
    "result" in body &&
    body.result &&
    typeof body.result === "object" &&
    "message_id" in body.result &&
    typeof body.result.message_id === "number" &&
    Number.isSafeInteger(body.result.message_id) &&
    body.result.message_id > 0
  )
    return { state: "sent", messageId: body.result.message_id };

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
  )
    return { state: "retry", afterSeconds: body.parameters.retry_after };

  if (
    body.ok === false &&
    "error_code" in body &&
    [400, 401, 403, 404].includes(Number(body.error_code))
  )
    return { state: "rejected" };

  return { state: "uncertain" };
}
