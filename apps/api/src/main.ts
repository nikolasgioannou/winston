/** The api service: public webhooks and OAuth callbacks (docs/design.md §9). */
import { createDb } from "@winston/db/client";
import { createLogger } from "@winston/shared/logger";
import { createApp } from "./app.ts";
import { loadApiConfig } from "./config.ts";

const config = loadApiConfig();
const logger = createLogger("api", { level: config.LOG_LEVEL });
const db = createDb(config.DATABASE_URL);
const server = Bun.serve({
  hostname: config.API_HOST,
  port: config.API_PORT,
  fetch: createApp({ db, logger }).fetch,
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
