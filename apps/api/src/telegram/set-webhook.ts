/**
 * `bun run telegram:webhook`: points the configured bot's webhook at this
 * api's public URL, then shows the webhook's status. Safe to re-run.
 */
import { loadConfig } from "@winston/shared/config";
import { Api } from "grammy";
import { z } from "zod";
import { allowedUpdates } from "./handle-update.ts";
import { telegramConfigSchema } from "./config.ts";

const config = loadConfig(
  telegramConfigSchema.extend({
    /** Where Telegram reaches the api: the tunnel locally, `https://api.runwinston.com` in production. */
    API_PUBLIC_URL: z.url({ protocol: /^https$/ }),
  }),
);

const api = new Api(config.TELEGRAM_BOT_TOKEN);
const url = new URL("/webhooks/telegram", config.API_PUBLIC_URL).href;
const me = await api.getMe();
await api.setWebhook(url, {
  secret_token: config.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: [...allowedUpdates],
});
const info = await api.getWebhookInfo();

console.log(`Webhook set for @${me.username}`);
console.log(`  url:             ${info.url ?? "(none)"}`);
console.log(`  allowed updates: ${(info.allowed_updates ?? []).join(", ")}`);
console.log(`  pending updates: ${String(info.pending_update_count)}`);
if (info.last_error_date !== undefined) {
  const at = new Date(info.last_error_date * 1000).toISOString();
  console.log(`  last error:      ${info.last_error_message ?? ""} (${at})`);
}
