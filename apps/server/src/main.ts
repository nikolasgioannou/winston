import { createOwnerAuth } from "@winston/adapters/auth";
import { createDatabase } from "@winston/adapters/database";
import { createOwnerRouter } from "./http/owner";
import { readAuthConfig } from "./auth-config";
import { readConfig } from "./config";
import { startServer } from "./host";
import {
  createTelegramClient,
  createTelegramStore,
  verifyTelegramWebhook,
} from "@winston/adapters/telegram";
import { createTelegramCallbackRouter, createTelegramOwnerRouter } from "./http/telegram";
import { startConversationRuntime } from "./conversation/runtime";
import { Hono } from "hono";
import type { HttpEnvironment, Identity } from "./http/app";
import { createGoogleConnections, createGoogleOAuth } from "@winston/adapters/google";
import { readConnectionConfig } from "./connection-config";
import { createConnectionOwnerRouter, createConnectionCallbackRouter } from "./http/connections";
import { createAuthorizationOwnerRouter } from "./http/authorization";
import { createTargetPreferencesRouter } from "./http/connection-targets";
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
const callbacks = new Hono<HttpEnvironment>();
owner.route("/devices", createDeviceOwnerRouter(database));
owner.route("/permissions", createAuthorizationOwnerRouter(database));
owner.route("/connection-targets", createTargetPreferencesRouter(database));
callbacks.route("/", createDevicePairingRouter(database));
const connectionConfig = readConnectionConfig(process.env, config.auth.baseURL);
if (connectionConfig) {
  const connections = createGoogleConnections({
    database,
    cipher: connectionConfig.cipher,
    oauth: createGoogleOAuth(connectionConfig.oauth),
  });
  owner.route("/connections", createConnectionOwnerRouter(connections));
  callbacks.route("/", createConnectionCallbackRouter(connections, config.auth.webOrigin));
}
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
let telegram: ReturnType<typeof createTelegramStore> | undefined;
let conversation: Awaited<ReturnType<typeof startConversationRuntime>> | undefined;

if (telegramToken || telegramSecret) {
  if (!telegramToken || !telegramSecret || !/^[A-Za-z0-9_-]{32,256}$/.test(telegramSecret)) {
    throw new Error("Telegram configuration is incomplete.");
  }
  const bot = await createTelegramClient(telegramToken).identity();
  telegram = createTelegramStore(config.connectionString, bot.id);
  callbacks.route("/", createTelegramCallbackRouter(telegram));
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
      telegramToken,
      notice: (code) => {
        console.error(code);
      },
    });
  }
}

const host = startServer(readConfig(process.env), {
  ...(process.env.WEB_ASSET_DIRECTORY ? { webRoot: process.env.WEB_ASSET_DIRECTORY } : {}),
  readiness: async () => {
    await database.assertCompatible();

    return true;
  },
  authHandler: (request) => auth.handle(request),
  ownerOrigin: config.auth.webOrigin,
  groups: {
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
      await Promise.all([auth.close(), database.close(), telegram?.close()]);
    })
    .catch(() => {
      console.error("Server shutdown failed.");
      process.exitCode = 1;
    });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
