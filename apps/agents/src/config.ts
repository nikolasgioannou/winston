import { dbConfigSchema } from "@winston/db/config";
import { loadConfig } from "@winston/shared/config";
import { logConfigSchema } from "@winston/shared/logger";
import { localVaultConfigSchema } from "@winston/shared/token-vault";
import { z } from "zod";

const agentsConfigSchema = dbConfigSchema
  .extend({
    ...logConfigSchema.shape,
    /** Opens connected accounts' tokens (KMS in production, M4). */
    ...localVaultConfigSchema.shape,
    OPENROUTER_API_KEY: z.string().min(1),
    /** The bot Winston talks through (the same one `api` receives for). */
    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d+:[\w-]+$/, "expected a bot token from @BotFather"),
    /** The front of house's rolling window: trim past the max, down to the target (tokens). */
    FRONT_WINDOW_MAX_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(150_000),
    FRONT_WINDOW_TARGET_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(100_000),
    /** The image local VMs run (`bun run image:build:local`). */
    VM_IMAGE: z.string().min(1).default("winston-vm:local"),
    /** Where `winstond` dials the gateway from inside a local VM container. */
    VM_GATEWAY_URL: z.url().default("ws://host.docker.internal:3001"),
    /** The gateway's internal API, how agents reach users' VMs. */
    GATEWAY_INTERNAL_URL: z.url().default("http://127.0.0.1:3001"),
    GATEWAY_INTERNAL_SECRET: z
      .string()
      .regex(/^[\w-]{32,}$/, "expected at least 32 letters, digits, _ or -"),
    /** Signs `WINSTON_RUN_TOKEN`s; the gateway verifies them with the same secret. */
    RUN_TOKEN_SECRET: z
      .string()
      .regex(/^[\w-]{32,}$/, "expected at least 32 letters, digits, _ or -"),
    /** Local blob storage for images and other binaries (S3 in production, M4). */
    BLOB_DIR: z
      .string()
      .min(1)
      .default(new URL("../../../.data/blobs", import.meta.url).pathname),
    /** Where the site is served, for links Winston sends (like reconnecting an account). */
    WEB_PUBLIC_URL: z.url().default("http://localhost:3002"),
    /** How many jobs this process runs at once. */
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
    /** How long in-flight jobs get to finish on shutdown before the process exits anyway. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  })
  .refine(
    (config) =>
      config.FRONT_WINDOW_TARGET_TOKENS < config.FRONT_WINDOW_MAX_TOKENS,
    {
      path: ["FRONT_WINDOW_TARGET_TOKENS"],
      message: "must be below FRONT_WINDOW_MAX_TOKENS",
    },
  );

export function loadAgentsConfig() {
  return loadConfig(agentsConfigSchema);
}
