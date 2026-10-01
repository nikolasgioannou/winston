/**
 * The agents service: runs front-of-house turns and background-agent steps
 * from the job queue (docs/design.md §9).
 */
import { createDb } from "@winston/db/client";
import {
  deleteUserJob,
  frontTurnJob,
  provisionVmJob,
  revokeConnectionTokenJob,
  saveAttachmentJob,
  transcribeVoiceJob,
} from "@winston/domain/jobs";
import { createLogger } from "@winston/shared/logger";
import { Api } from "grammy";
import {
  saveAttachmentHandler,
  transcribeVoiceHandler,
} from "./attachments.ts";
import { localBlobStore } from "./blobs.ts";
import { loadAgentsConfig } from "./config.ts";
import { frontTurnHandler } from "./front/handler.ts";
import { createModelGateway } from "./model/gateway.ts";
import { dbModelCallSink } from "./model/log.ts";
import { botApiFiles } from "./telegram/files.ts";
import { openRouterTranscriber } from "./transcribe.ts";
import { grammySender } from "./telegram/sender.ts";
import { dockerEngine, dockerSocketPath } from "./vm/docker-engine.ts";
import { gatewayClient } from "./vm/gateway-client.ts";
import { dockerVmProvider } from "./vm/docker-provider.ts";
import {
  googleTokenRevoker,
  revokeConnectionTokenHandler,
} from "./connections/revoke.ts";
import { createTokenVault } from "@winston/shared/token-vault";
import { deleteUserHandler } from "./accounts/delete-user.ts";
import {
  reconnectUrlFor,
  sweepConnectionGrants,
} from "./connections/grants.ts";
import { provisionVmHandler } from "./vm/provision.ts";
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
const telegramApi = new Api(config.TELEGRAM_BOT_TOKEN);
const telegram = grammySender(telegramApi);
const vm = gatewayClient({
  baseUrl: config.GATEWAY_INTERNAL_URL,
  secret: config.GATEWAY_INTERNAL_SECRET,
});
const blobs = localBlobStore(config.BLOB_DIR);

const vmProvider = dockerVmProvider({
  engine: dockerEngine(await dockerSocketPath()),
  image: config.VM_IMAGE,
  gatewayUrl: config.VM_GATEWAY_URL,
});

const tokenVault = createTokenVault(config);

const worker = createWorker({
  db,
  logger,
  handlers: {
    [provisionVmJob.type]: provisionVmHandler(vmProvider),
    [revokeConnectionTokenJob.type]: revokeConnectionTokenHandler({
      vault: tokenVault,
      revoke: googleTokenRevoker(),
    }),
    [deleteUserJob.type]: deleteUserHandler({
      provider: vmProvider,
      vault: tokenVault,
      revoke: googleTokenRevoker(),
      blobs,
      telegram,
    }),
    [saveAttachmentJob.type]: saveAttachmentHandler({
      vm,
      telegram: botApiFiles(telegramApi, config.TELEGRAM_BOT_TOKEN),
      blobs,
    }),
    [transcribeVoiceJob.type]: transcribeVoiceHandler({
      vm,
      transcriber: openRouterTranscriber({ apiKey: config.OPENROUTER_API_KEY }),
    }),
    [frontTurnJob.type]: frontTurnHandler({
      gateway,
      telegram,
      vm,
      runTokenSecret: config.RUN_TOKEN_SECRET,
      blobs,
      window: {
        maxTokens: config.FRONT_WINDOW_MAX_TOKENS,
        targetTokens: config.FRONT_WINDOW_TARGET_TOKENS,
      },
    }),
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
  clearInterval(grantSweeper);
  await worker.stop();
  await db.$client.end();
  clearTimeout(timeout);
  logger.info("stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/** How often connections' grants are checked for running out. */
const grantSweepMs = 5 * 60_000;
const reconnectUrl = reconnectUrlFor(config.WEB_PUBLIC_URL);
const sweepGrants = () => {
  sweepConnectionGrants(db, logger, { reconnectUrl }).catch(
    (error: unknown) => {
      logger.error({ err: error }, "sweeping connection grants failed");
    },
  );
};
const grantSweeper = setInterval(sweepGrants, grantSweepMs);
sweepGrants();

worker.start();
logger.info({ concurrency: config.WORKER_CONCURRENCY }, "agents started");
