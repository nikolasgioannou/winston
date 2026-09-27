import { dbConfigSchema } from "@winston/db/config";
import { loadConfig } from "@winston/shared/config";
import { logConfigSchema } from "@winston/shared/logger";
import { z } from "zod";

const agentsConfigSchema = dbConfigSchema.extend({
  ...logConfigSchema.shape,
  OPENROUTER_API_KEY: z.string().min(1),
  /** The bot Winston talks through (the same one `api` receives for). */
  TELEGRAM_BOT_TOKEN: z
    .string()
    .regex(/^\d+:[\w-]+$/, "expected a bot token from @BotFather"),
  /** How many jobs this process runs at once. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** How long in-flight jobs get to finish on shutdown before the process exits anyway. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export function loadAgentsConfig() {
  return loadConfig(agentsConfigSchema);
}
