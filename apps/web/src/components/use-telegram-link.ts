import { useEffect, useState } from "react";
import { createTelegramLink } from "../server/telegram-functions";
import type { TelegramDeepLink } from "../server/telegram-state";

/** How long before a link expires it's replaced. */
const refreshBeforeMs = 60_000;
const retryAfterMs = 10_000;

/**
 * A Connect Telegram link while `active`, issued when needed and replaced
 * before it expires, or null while there isn't one yet.
 */
export function useTelegramLink(active: boolean) {
  const [link, setLink] = useState<TelegramDeepLink | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const issue = async () => {
      let next: TelegramDeepLink | undefined;
      try {
        next = await createTelegramLink();
      } catch {
        // Try again shortly; the button waits meanwhile.
      }
      if (cancelled) return;
      if (next) setLink(next);
      timer = setTimeout(
        () => void issue(),
        next
          ? Date.parse(next.expiresAt) - Date.now() - refreshBeforeMs
          : retryAfterMs,
      );
    };
    void issue();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active]);
  return active ? (link?.url ?? null) : null;
}
