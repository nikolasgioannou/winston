/**
 * Keeps Chrome answering (docs/design.md §10, Process supervision): systemd
 * restarts a Chrome that exits, but not one that hangs. winstond asks Chrome
 * for its version over CDP every 30 s, and restarts the unit once it hasn't
 * answered for 60 s.
 */
import { existsSync } from "node:fs";
import type { Logger } from "@winston/shared/logger";

export const chromeWatch = {
  everyMs: 30_000,
  unresponsiveMs: 60_000,
  probeTimeoutMs: 5_000,
};

export interface ChromeWatchDeps {
  /** Whether Chrome answered. */
  probe: () => Promise<boolean>;
  restart: () => Promise<void>;
  logger: Logger;
  now?: () => number;
}

/** One check; call it every `chromeWatch.everyMs`. */
export function createChromeWatch(deps: ChromeWatchDeps) {
  const now = deps.now ?? Date.now;
  let lastAnswer = now();
  return async function check() {
    if (await deps.probe()) {
      lastAnswer = now();
      return "ok" as const;
    }
    if (now() - lastAnswer < chromeWatch.unresponsiveMs)
      return "waiting" as const;
    deps.logger.warn(
      { silentForMs: now() - lastAnswer },
      "Chrome stopped answering over CDP; restarting it",
    );
    // Give the new Chrome a full window before judging it.
    lastAnswer = now();
    try {
      await deps.restart();
    } catch (error) {
      deps.logger.error({ err: error }, "restarting Chrome failed");
    }
    return "restarted" as const;
  };
}

/** Chrome's DevTools endpoint on this machine (localhost only). */
const devtoolsUrl = "http://127.0.0.1:9222/json/version";

/**
 * Watches the VM's Chrome, if it has one (images from before the browser
 * don't). Returns a stop function.
 */
export function watchChrome(logger: Logger) {
  if (!existsSync("/opt/google/chrome/chrome")) return () => undefined;
  const check = createChromeWatch({
    probe: async () => {
      try {
        const response = await fetch(devtoolsUrl, {
          signal: AbortSignal.timeout(chromeWatch.probeTimeoutMs),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    restart: async () => {
      const proc = Bun.spawn(
        ["sudo", "-n", "/usr/bin/systemctl", "restart", "chrome.service"],
        { stdout: "ignore", stderr: "pipe" },
      );
      const code = await proc.exited;
      if (code !== 0)
        throw new Error(
          `systemctl restart chrome.service exited ${String(code)}: ${(await new Response(proc.stderr).text()).trim()}`,
        );
    },
    logger,
  });
  const timer = setInterval(() => void check(), chromeWatch.everyMs);
  return () => {
    clearInterval(timer);
  };
}
