import type { Logger } from "@winston/shared/logger";

/** Telegram's "typing…" lasts about 5 s, so it's re-sent a little sooner. */
export const typingIntervalMs = 4_000;

export interface Timers {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const realTimers: Timers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Shows "typing…" now and keeps it up until `stop()` (docs/design.md §4).
 * Failures are logged and ignored: the indicator must never fail a turn.
 * Telegram can't cancel the indicator, so after `stop()` it fades within
 * about 5 s unless a message is sent, which clears it at once.
 *
 * `sent()` is called after each message or file: sending cleared the
 * indicator, so it's shown again only if the turn is still working an
 * interval later. The short wrap-up call that often follows a last message
 * then shows no stray "typing…".
 */
export function startTyping(
  sendTyping: () => Promise<unknown>,
  logger: Logger,
  timers: Timers = realTimers,
) {
  const send = () => {
    sendTyping().catch((error: unknown) => {
      logger.warn({ err: error }, "sending the typing indicator failed");
    });
  };
  send();
  let handle = timers.setInterval(send, typingIntervalMs);
  let stopped = false;
  return {
    sent() {
      if (stopped) return;
      timers.clearInterval(handle);
      handle = timers.setInterval(send, typingIntervalMs);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(handle);
    },
  };
}
