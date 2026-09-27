import type { DbOrTx } from "@winston/db/client";
import { createLogger } from "@winston/shared/logger";
import type { ApiDeps } from "./app.ts";

export const testWebhookSecret = "test-secret-0123456789abcdefghijklmnop";

/** Deps for driving the app in tests: captured log lines and a recording Telegram sender. */
export function testDeps(db: DbOrTx) {
  const logs: Record<string, unknown>[] = [];
  const sent: { chatId: number; text: string }[] = [];
  const logger = createLogger("api-test", {
    pretty: false,
    destination: {
      write: (line: string) =>
        logs.push(JSON.parse(line) as Record<string, unknown>),
    },
  });
  const deps: ApiDeps = {
    db,
    logger,
    telegram: {
      sender: {
        sendMessage: (chatId, text) => {
          sent.push({ chatId, text });
          return Promise.resolve();
        },
      },
      botId: "123456",
      webhookSecret: testWebhookSecret,
    },
  };
  return { deps, logs, sent };
}
