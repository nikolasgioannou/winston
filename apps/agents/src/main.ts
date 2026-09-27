/**
 * The agents service: runs front-of-house turns and background-agent steps
 * from the job queue (docs/design.md §9).
 */
import { createDb } from "@winston/db/client";
import { frontTurnJob } from "@winston/domain/jobs";
import { createLogger } from "@winston/shared/logger";
import { Api } from "grammy";
import { loadAgentsConfig } from "./config.ts";
import { frontTurnHandler } from "./front/handler.ts";
import { createModelGateway } from "./model/gateway.ts";
import { dbModelCallSink } from "./model/log.ts";
import { createWorker } from "./worker.ts";

const config = loadAgentsConfig();
const logger = createLogger("agents", {
  level: config.LOG_LEVEL,
  pretty: config.LOG_PRETTY,
});
const db = createDb(config.DATABASE_URL);

const gateway = createModelGateway({
  apiKey: config.OPENROUTER_API_KEY,
  sink: dbModelCallSink(db, logger),
});
const telegram = new Api(config.TELEGRAM_BOT_TOKEN);

const worker = createWorker({
  db,
  logger,
  handlers: {
    [frontTurnJob.type]: frontTurnHandler({ gateway, telegram }),
  },
  concurrency: config.WORKER_CONCURRENCY,
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) {
    logger.warn({ signal }, "second signal, exiting now");
    process.exit(1);
  }
  stopping = true;
  logger.info({ signal }, "stopping: finishing in-flight jobs");
  const timeout = setTimeout(() => {
    logger.warn(
      "shutdown timed out, exiting; unfinished jobs will be retried when their leases expire",
    );
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  await worker.stop();
  await db.$client.end();
  clearTimeout(timeout);
  logger.info("stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

worker.start();
logger.info({ concurrency: config.WORKER_CONCURRENCY }, "agents started");
