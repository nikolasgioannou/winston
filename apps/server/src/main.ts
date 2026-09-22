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
  readiness: async () => {
    await database.assertCompatible();

    return true;
  },
  authHandler: (request) => auth.handle(request),
  ownerOrigin: config.auth.webOrigin,
  groups: {
    ...(telegram && telegramSecret
      ? {
          callback: {
            router: createTelegramCallbackRouter(telegram),
            authenticate: (request: Request) =>
              Promise.resolve(
                new URL(request.url).pathname === "/callbacks/telegram" &&
                  verifyTelegramWebhook(
                    request.headers.get("X-Telegram-Bot-Api-Secret-Token"),
                    telegramSecret,
                  )
                  ? { kind: "callback" as const, provider: "telegram" }
                  : null,
              ),
          },
        }
      : {}),
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
