import { createTelegramClient, createTelegramStore } from "@winston/adapters/telegram";
import { readAuthConfig } from "./auth-config";

if (process.env.NODE_ENV === "production")
  throw new Error("Telegram polling is for local development only.");
const config = readAuthConfig(process.env);
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("A development Telegram bot token is required.");

const client = createTelegramClient(token);
const bot = await client.identity();
const store = createTelegramStore(config.connectionString, bot.id);
const controller = new AbortController();
process.once("SIGINT", () => {
  controller.abort();
});
process.once("SIGTERM", () => {
  controller.abort();
});
let offset: number | undefined;

console.log(`Polling @${bot.username}. Updates are acknowledged only after durable handling.`);

try {
  while (!controller.signal.aborted) {
    const updates = await client.updates(offset, controller.signal);

    for (const update of updates) {
      controller.signal.throwIfAborted();
      const result = await store.receive(update);
      offset = update.update_id + 1;
      console.log(JSON.stringify({ result }));
    }
  }
} catch {
  if (!controller.signal.aborted) {
    console.error(
      "Telegram polling stopped. Check connectivity and ensure no webhook or other poller is active.",
    );
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
