/**
 * The agents service: runs front-of-house turns and background-agent steps
 * from the job queue (docs/design.md §9).
 */
import { createDb } from "@winston/db/client";
import {
  deleteUserJob,
  expireTriggerJob,
  fireDerivedTimerJob,
  fireScheduleJob,
  fireTriggerBatchJob,
  matchEventsJob,
  refreshTimersJob,
  frontTurnJob,
  provisionVmJob,
  restoreVmJob,
  rollVmJob,
  closeTaskBrowserJob,
  revokeConnectionTokenJob,
  runStepJob,
  syncConnectionJob,
  watchConnectionJob,
  saveAttachmentJob,
  transcribeVoiceJob,
} from "@winston/domain/jobs";
import { createLogger } from "@winston/shared/logger";
import { Api } from "grammy";
import {
  saveAttachmentHandler,
  transcribeVoiceHandler,
} from "./attachments.ts";
import { runStepHandler, stepLeaseMs } from "./background/handler.ts";
import { closeTaskBrowserHandler } from "./background/close-browser.ts";
import { createBlobStore } from "./blobs.ts";
import { loadAgentsConfig } from "./config.ts";
import { frontTurnHandler } from "./front/handler.ts";
import { createModelGateway } from "./model/gateway.ts";
import { dbModelCallSink } from "./model/log.ts";
import { botApiFiles } from "./telegram/files.ts";
import { openRouterTranscriber } from "./transcribe.ts";
import { grammySender } from "./telegram/sender.ts";
import { dockerEngine, dockerSocketPath } from "./vm/docker-engine.ts";
import { startVmCostJob } from "./vm/costs.ts";
import { gatewayClient } from "./vm/gateway-client.ts";
import { dockerVmProvider } from "./vm/docker-provider.ts";
import { ec2VmProvider } from "./vm/ec2-provider.ts";
import {
  googleTokenRevoker,
  revokeConnectionTokenHandler,
} from "./connections/revoke.ts";
import { startReconciliation } from "./connections/reconcile.ts";
import { watchConnectionHandler, watchStopper } from "./connections/watch.ts";
import { googleAccessTokens } from "@winston/connectors/access-token";
import { gmailProvider } from "@winston/connectors/gmail";
import { gmailSync } from "@winston/connectors/gmail-sync";
import { googleCalendarSync } from "@winston/connectors/google-calendar-sync";
import { syncConnectionHandler } from "./connections/sync.ts";
import {
  fireTriggerBatchHandler,
  gmailNativeCheck,
  matchEventsHandler,
} from "./triggers/matching.ts";
import {
  fireDerivedTimerHandler,
  refreshTimersHandler,
  type CalendarFor,
} from "./triggers/timers.ts";
import { googleCalendarProvider } from "@winston/connectors/google-calendar";
import { connections, vms } from "@winston/db/schema";
import { eq } from "drizzle-orm";
import { createTokenVault } from "@winston/shared/token-vault";
import { deleteUserHandler } from "./accounts/delete-user.ts";
import {
  reconnectUrlFor,
  sweepConnectionGrants,
} from "@winston/connectors/grants";
import { provisionVmHandler, restoreVmHandler } from "./vm/provision.ts";
import {
  parseHours,
  rolloutEveryMs,
  rollVmHandler,
  sweepRollouts,
} from "./vm/rollout.ts";
import {
  expireTriggerHandler,
  fireScheduleHandler,
  startScheduler,
} from "./scheduler.ts";
import { createWorker } from "./worker.ts";

const config = loadAgentsConfig();
const logger = createLogger("agents", {
  level: config.LOG_LEVEL,
  pretty: config.LOG_PRETTY,
});
const db = createDb(config.DATABASE_URL, {
  rdsSecretArn: config.DATABASE_SECRET_ARN,
});

const gateway = createModelGateway({
  apiKey: config.OPENROUTER_API_KEY,
  sink: dbModelCallSink(db, logger),
});
const telegramApi = new Api(config.TELEGRAM_BOT_TOKEN);
const telegram = grammySender(telegramApi);
const vm = gatewayClient({
  baseUrl: config.GATEWAY_INTERNAL_URL,
  secret: config.GATEWAY_INTERNAL_SECRET,
  // The gateway holding the VM's connection (a deploy briefly runs two).
  locate: async (userId) =>
    (
      await db
        .select({ gatewayUrl: vms.gatewayUrl })
        .from(vms)
        .where(eq(vms.userId, userId))
    )[0]?.gatewayUrl,
});
const blobs = createBlobStore(config);

/** When VMs move onto a new image: the quiet hours on EC2, any time locally. */
const rolloutHours = parseHours(
  config.VM_ROLLOUT_HOURS ?? (config.VM_PROVIDER === "ec2" ? "3-5" : "0-24"),
);
const vmProvider =
  config.VM_PROVIDER === "ec2"
    ? ec2VmProvider({
        launchTemplateName: config.EC2_LAUNCH_TEMPLATE,
        subnetIds: config.EC2_SUBNET_IDS,
        gatewayUrl: config.VM_GATEWAY_URL,
      })
    : dockerVmProvider({
        engine: dockerEngine(await dockerSocketPath()),
        image: config.VM_IMAGE,
        gatewayUrl: config.VM_GATEWAY_URL,
      });

const tokenVault = createTokenVault(config);
const googleClient = {
  clientId: config.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
};
// Connected accounts' access tokens, for watches and syncs (§12a).
const accessToken = googleAccessTokens({
  db,
  vault: tokenVault,
  client: googleClient,
  reconnectUrl: reconnectUrlFor(config.WEB_PUBLIC_URL),
});

// A calendar account's provider, for heads-up timers.
const calendarFor: CalendarFor = (connection) =>
  googleCalendarProvider({
    address: connection.externalEmail,
    accessToken: () => accessToken(connection.id),
  });

const worker = createWorker({
  db,
  logger,
  handlers: {
    [provisionVmJob.type]: provisionVmHandler(vmProvider),
    [restoreVmJob.type]: restoreVmHandler(vmProvider),
    [rollVmJob.type]: rollVmHandler(vmProvider, rolloutHours),
    [revokeConnectionTokenJob.type]: revokeConnectionTokenHandler({
      vault: tokenVault,
      revoke: googleTokenRevoker(),
      stopWatch: watchStopper(db, googleClient),
    }),
    [fireTriggerBatchJob.type]: fireTriggerBatchHandler,
    [matchEventsJob.type]: matchEventsHandler,
    [refreshTimersJob.type]: refreshTimersHandler(calendarFor),
    [fireDerivedTimerJob.type]: fireDerivedTimerHandler(calendarFor),
    [syncConnectionJob.type]: syncConnectionHandler({
      native: gmailNativeCheck(async (connectionId) => {
        const [connection] = await db
          .select({ email: connections.externalEmail })
          .from(connections)
          .where(eq(connections.id, connectionId));
        return gmailProvider({
          address: connection?.email ?? "",
          accessToken: () => accessToken(connectionId),
        });
      }),
      calendar: (connection) => ({
        sync: googleCalendarSync({
          accessToken: () => accessToken(connection.id),
        }),
      }),
      mail: (connection) => ({
        sync: gmailSync({ accessToken: () => accessToken(connection.id) }),
        mail: gmailProvider({
          address: connection.externalEmail,
          accessToken: () => accessToken(connection.id),
        }),
      }),
    }),
    [watchConnectionJob.type]: watchConnectionHandler({
      accessToken,
      gmailTopic: config.GMAIL_PUSH_TOPIC,
      calendarAddress: config.CALENDAR_PUSH_URL,
    }),
    [deleteUserJob.type]: deleteUserHandler({
      provider: vmProvider,
      vault: tokenVault,
      revoke: googleTokenRevoker(),
      blobs,
      telegram,
    }),
    [closeTaskBrowserJob.type]: closeTaskBrowserHandler(vm),
    [saveAttachmentJob.type]: saveAttachmentHandler({
      vm,
      telegram: botApiFiles(telegramApi, config.TELEGRAM_BOT_TOKEN),
      blobs,
    }),
    [transcribeVoiceJob.type]: transcribeVoiceHandler({
      vm,
      transcriber: openRouterTranscriber({ apiKey: config.OPENROUTER_API_KEY }),
    }),
    [fireScheduleJob.type]: fireScheduleHandler,
    [expireTriggerJob.type]: expireTriggerHandler,
    [frontTurnJob.type]: frontTurnHandler({
      gateway,
      telegram,
      vm,
      runTokenSecret: config.RUN_TOKEN_SECRET,
      blobs,
      webPublicUrl: config.WEB_PUBLIC_URL,
      window: {
        maxTokens: config.FRONT_WINDOW_MAX_TOKENS,
        targetTokens: config.FRONT_WINDOW_TARGET_TOKENS,
      },
    }),
  },
  concurrency: config.WORKER_CONCURRENCY,
});

// Background steps get their own pool, so long tasks never hold up a reply (§9).
const backgroundWorker = createWorker({
  db,
  logger,
  handlers: {
    [runStepJob.type]: runStepHandler({
      gateway,
      vm,
      runTokenSecret: config.RUN_TOKEN_SECRET,
      blobs,
      webPublicUrl: config.WEB_PUBLIC_URL,
    }),
  },
  concurrency: config.BACKGROUND_CONCURRENCY,
  leaseMs: stepLeaseMs,
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
  clearInterval(rolloutSweeper);
  stopVmCosts();
  scheduler.stop();
  reconciliation.stop();
  await Promise.all([worker.stop(), backgroundWorker.stop()]);
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

// VMs move onto a new image by themselves, in their users' quiet hours (§18).
const sweepRollout = () => {
  sweepRollouts(db, logger, vmProvider, rolloutHours).catch(
    (error: unknown) => {
      logger.error({ err: error }, "sweeping VM rollouts failed");
    },
  );
};
const rolloutSweeper = setInterval(sweepRollout, rolloutEveryMs);
sweepRollout();

// Each user's computer goes into their spend, hour by hour (§8).
const stopVmCosts = startVmCostJob(db, logger);

worker.start();
backgroundWorker.start();
const scheduler = startScheduler(db, logger);
const reconciliation = startReconciliation(db, logger);
logger.info(
  {
    concurrency: config.WORKER_CONCURRENCY,
    backgroundConcurrency: config.BACKGROUND_CONCURRENCY,
  },
  "agents started",
);
