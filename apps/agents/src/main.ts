/**
 * The agents service: runs front-of-house turns and background-agent steps
 * from the job queue (docs/design.md §9).
 */
import { createDb } from "@winston/db/client";
import { createLogger } from "@winston/shared/logger";
import { loadAgentsConfig } from "./config.ts";
import { createWorker } from "./worker.ts";

const config = loadAgentsConfig();
const logger = createLogger("agents", {
  level: config.LOG_LEVEL,
  pretty: config.LOG_PRETTY,
});
const db = createDb(config.DATABASE_URL);

// Job handlers are registered here as the tickets that need them arrive.
const worker = createWorker({
  db,
  logger,
  handlers: {},
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
