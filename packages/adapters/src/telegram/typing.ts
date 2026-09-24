export function createTelegramTypingSender(token: string) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Telegram token is invalid.");
  let retryAt = 0;

  return async (chatId: string, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted || Date.now() < retryAt || !/^-?\d+$/.test(chatId)) return false;
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      if (response.status === 429) {
        // Indicators are disposable. Pause subsequent turns instead of retrying this request.
        retryAt = Date.now() + 60_000;
        const value: unknown = await response.json();
        if (value && typeof value === "object" && "parameters" in value) {
          const parameters = value.parameters;
          if (
            parameters &&
            typeof parameters === "object" &&
            "retry_after" in parameters &&
            typeof parameters.retry_after === "number" &&
            Number.isFinite(parameters.retry_after)
          ) {
            retryAt = Date.now() + Math.max(60, Math.min(86_400, parameters.retry_after)) * 1000;
          }
        }
        return false;
      }
      const result: unknown = await response.json();
      return (
        response.ok &&
        typeof result === "object" &&
        result !== null &&
        "ok" in result &&
        result.ok === true
      );
    } catch {
      // Never propagate an error containing the credential-bearing Telegram URL.
      return false;
    }
  };
}
