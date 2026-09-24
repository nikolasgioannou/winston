import { createOwnerAuth } from "@winston/adapters/auth";
import { createDatabase } from "@winston/adapters/database";
import { createOwnerRouter } from "./http/owner";
import { createWorkspaceOwnerRouter } from "./http/workspace-catalog";
import { createScheduleOwnerRouter } from "./http/schedules";
import { createActivityOwnerRouter } from "./http/activity";
import { createResponsibilityOwnerRouter } from "./http/responsibilities";
import { createHandoffOwnerRouter } from "./http/handoffs";
import { readAuthConfig } from "./auth-config";
import { readConfig } from "./config";
import { startServer } from "./host";
import { createDeviceSocketTransport } from "./devices/socket";
import { createDevicePresenceRouter } from "./http/device-presence";
import { createObjectStorage } from "@winston/adapters/storage";
import {
  createArtifactService,
  createWorkspaceFilePublisher,
  createArtifactReader,
  createDeliveryDownloadService,
} from "@winston/adapters/artifacts";
import { startFileDeliveryRuntime } from "./files/runtime";
import { startFileIntakeRuntime, startInboxStagingRuntime } from "./files/intake-runtime";
import { createInboxTransferGroup } from "./http/inbox-transfers";
import { startVoiceRuntime } from "./files/voice-runtime";
import { createFileCommands } from "./files/cli";
import { readStorageConfig } from "./storage-config";
import { createArtifactOwnerRouter } from "./http/artifacts";
import { createFileDeliveryOwnerRouter } from "./http/file-deliveries";
import {
  createTelegramClient,
  createTelegramStore,
  verifyTelegramWebhook,
} from "@winston/adapters/telegram";
import { createTelegramCallbackRouter, createTelegramOwnerRouter } from "./http/telegram";
import { startConversationRuntime } from "./conversation/runtime";
import { Hono } from "hono";
import type { HttpEnvironment, Identity } from "./http/app";
import {
  createGoogleConnections,
  createGoogleOAuth,
  createConnectedReadGateway,
} from "@winston/adapters/google";
import { readConnectionConfig } from "./connection-config";
import { createConnectionOwnerRouter, createConnectionCallbackRouter } from "./http/connections";
import { createAuthorizationOwnerRouter } from "./http/authorization";
import { createTargetPreferencesRouter } from "./http/connection-targets";
import { createWorkspaceTaskGroup } from "./http/workspaces";
import { createCliTaskGroup } from "./http/cli";
import {
  authenticateDevicePairing,
  createDeviceGroup,
  createDeviceOwnerRouter,
  createDevicePairingRouter,
} from "./http/devices";

const config = readAuthConfig(process.env);
const database = createDatabase({
  connectionString: config.connectionString,
  onConnectionError: () => {
    console.error("Application database connection lost.");
  },
});

try {
  await database.assertCompatible();
} catch {
  await database.close();
  console.error("Database startup failed. Check connectivity and apply the release migrations.");
  process.exit(1);
}

const auth = createOwnerAuth(config.auth, config.connectionString);
const owner = createOwnerRouter(database);
owner.route("/workspaces", createWorkspaceOwnerRouter(database));
owner.route("/schedules", createScheduleOwnerRouter(database));
owner.route("/activity", createActivityOwnerRouter(database));
owner.route("/responsibilities", createResponsibilityOwnerRouter(database));
const callbacks = new Hono<HttpEnvironment>();
const storageConfig = readStorageConfig(process.env);
const storage = storageConfig ? createObjectStorage(storageConfig) : undefined;
if (storage) {
  owner.route("/artifacts", createArtifactOwnerRouter(createArtifactService(database, storage)));
  owner.route(
    "/file-deliveries",
    createFileDeliveryOwnerRouter(createDeliveryDownloadService(database, storage)),
  );
}
owner.route("/devices", createDeviceOwnerRouter(database));
owner.route("/devices/presence", createDevicePresenceRouter(database));
owner.route("/permissions", createAuthorizationOwnerRouter(database));
owner.route("/connection-targets", createTargetPreferencesRouter(database));
callbacks.route("/", createDevicePairingRouter(database));
const connectionConfig = readConnectionConfig(process.env, config.auth.baseURL);
let connectedReads: ReturnType<typeof createConnectedReadGateway> | undefined;
if (connectionConfig) {
  const connections = createGoogleConnections({
    database,
    cipher: connectionConfig.cipher,
    oauth: createGoogleOAuth(connectionConfig.oauth),
  });
  connectedReads = createConnectedReadGateway({ database, google: connections });
  owner.route("/connections", createConnectionOwnerRouter(connections));
  owner.route("/handoffs", createHandoffOwnerRouter(database, connections));
  callbacks.route("/", createConnectionCallbackRouter(connections, config.auth.webOrigin));
}
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
let telegram: ReturnType<typeof createTelegramStore> | undefined;
let conversation: Awaited<ReturnType<typeof startConversationRuntime>> | undefined;
let fileDelivery: ReturnType<typeof startFileDeliveryRuntime> | undefined;
let fileIntake: ReturnType<typeof startFileIntakeRuntime> | undefined;
let inboxStaging: ReturnType<typeof startInboxStagingRuntime> | undefined;
let voiceRuntime: ReturnType<typeof startVoiceRuntime> | undefined;
let fileCommands: ReturnType<typeof createFileCommands> | undefined;

if (telegramToken || telegramSecret) {
  if (!telegramToken || !telegramSecret || !/^[A-Za-z0-9_-]{32,256}$/.test(telegramSecret)) {
    throw new Error("Telegram configuration is incomplete.");
  }
  const telegramClient = createTelegramClient(telegramToken);
  const bot = await telegramClient.identity();
  if (storage) {
    if (process.env.OPENROUTER_API_KEY) {
      voiceRuntime = startVoiceRuntime({
        database,
        botId: bot.id,
        apiKey: process.env.OPENROUTER_API_KEY,
        read: createArtifactReader(database, storage),
        notice: (code) => {
          console.error(code);
        },
      });
    }
    inboxStaging = startInboxStagingRuntime({
      database,
      botId: bot.id,
      read: createArtifactReader(database, storage),
      notice: (code) => {
        console.error(code);
      },
    });
    fileIntake = startFileIntakeRuntime({
      database,
      botId: bot.id,
      token: telegramToken,
      artifacts: createArtifactService(database, storage),
      notice: (code) => {
        console.error(code);
      },
    });
    fileCommands = createFileCommands(database, bot.id);
    fileDelivery = startFileDeliveryRuntime({
      webOrigin: config.auth.webOrigin,
      database,
      botId: bot.id,
      token: telegramToken,
      read: createArtifactReader(database, storage),
      notice: (code) => {
        console.error(code);
      },
    });
  }
  telegram = createTelegramStore(config.connectionString, bot.id);
  callbacks.route(
    "/",
    createTelegramCallbackRouter(telegram, (id, text) => telegramClient.answerCallback(id, text)),
  );
  owner.route("/telegram", createTelegramOwnerRouter(telegram, bot.username));
  if (process.env.OPENROUTER_API_KEY) {
    const directConnectionString =
      process.env.DIRECT_DATABASE_URL ??
      (process.env.NODE_ENV === "production" ? undefined : config.connectionString);
    if (!directConnectionString)
      throw new Error("Conversation workers require DIRECT_DATABASE_URL.");
    conversation = await startConversationRuntime({
      database,
      directConnectionString,
      apiKey: process.env.OPENROUTER_API_KEY,
      botId: bot.id,
      webOrigin: config.auth.webOrigin,
      telegramToken,
      notice: (code) => {
        console.error(code);
      },
    });
  }
}

const workspaceTasks = createWorkspaceTaskGroup(
  database,
  process.env.NODE_ENV === "production" ? "production" : "local",
);
const cliTasks = createCliTaskGroup(
  database,
  connectedReads,
  storage
    ? createWorkspaceFilePublisher({
        database,
        artifacts: createArtifactService(database, storage),
      })
    : undefined,
  fileCommands,
);
const taskRouter = new Hono<HttpEnvironment>();
taskRouter.route("/", workspaceTasks.router);
taskRouter.route("/", cliTasks.router);

const host = startServer(readConfig(process.env), {
  deviceTransport: createDeviceSocketTransport(database),
  ...(process.env.WEB_ASSET_DIRECTORY ? { webRoot: process.env.WEB_ASSET_DIRECTORY } : {}),
  readiness: async () => {
    await database.assertCompatible();

    return true;
  },
  authHandler: (request) => auth.handle(request),
  ownerOrigin: config.auth.webOrigin,
  groups: {
    transfer: createInboxTransferGroup(database),
    task: {
      router: taskRouter,
      authenticate: async (request) =>
        (await workspaceTasks.authenticate(request)) ?? cliTasks.authenticate(request),
    },
    device: createDeviceGroup(database),
    callback: {
      router: callbacks,
      async authenticate(request): Promise<Identity | null> {
        const path = new URL(request.url).pathname;
        if (
          path === "/callbacks/telegram" &&
          telegram &&
          telegramSecret &&
          verifyTelegramWebhook(
            request.headers.get("X-Telegram-Bot-Api-Secret-Token"),
            telegramSecret,
          )
        )
          return { kind: "callback", provider: "telegram" };
        if (path === "/callbacks/google/connections" && connectionConfig) {
          const session = await auth.owner(request);
          if (session)
            return {
              kind: "callback",
              provider: "google",
              ownerId: session.ownerId,
              sessionId: session.sessionId,
            };
        }
        return authenticateDevicePairing(database, request);
      },
    },
    owner: {
      router: owner,
      async authenticate(request) {
        const session = await auth.owner(request);

        if (!session) {
          return null;
        }

        await database.transaction(session.ownerId, (scope) => scope.owners.ensure());

        return { kind: "owner", ownerId: session.ownerId, sessionId: session.sessionId };
      },
    },
  },
  log: (entry) => {
    console.log(JSON.stringify(entry));
  },
});

function shutdown() {
  host
    .stop()
    .then(async () => {
      await conversation?.stop();
      await fileDelivery?.stop();
      await fileIntake?.stop();
      await inboxStaging?.stop();
      await voiceRuntime?.stop();
      storage?.close();
      await Promise.all([auth.close(), database.close(), telegram?.close()]);
    })
    .catch(() => {
      console.error("Server shutdown failed.");
      process.exitCode = 1;
    });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
