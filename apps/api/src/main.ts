/** The api service: public webhooks and OAuth callbacks (docs/design.md §9). */
import { createDb } from "@winston/db/client";
import { createLogger } from "@winston/shared/logger";
import { Api } from "grammy";
import { createApp } from "./app.ts";
import { loadApiConfig } from "./config.ts";
import { botIdFromToken } from "./telegram/config.ts";

const config = loadApiConfig();
const logger = createLogger("api", {
  level: config.LOG_LEVEL,
  pretty: config.LOG_PRETTY,
});
const db = createDb(config.DATABASE_URL, {
  rdsSecretArn: config.DATABASE_SECRET_ARN,
});
const server = Bun.serve({
  hostname: config.API_HOST,
  port: config.API_PORT,
  fetch: createApp({
    db,
    logger,
    telegram: {
      sender: new Api(config.TELEGRAM_BOT_TOKEN),
      botId: botIdFromToken(config.TELEGRAM_BOT_TOKEN),
      webhookSecret: config.TELEGRAM_WEBHOOK_SECRET,
    },
  }).fetch,
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) process.exit(1);
  stopping = true;
  logger.info({ signal }, "stopping: finishing in-flight requests");
  await server.stop();
  await db.$client.end();
  logger.info("stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info({ url: server.url.href }, "api listening");
