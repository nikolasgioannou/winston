import { dbConfigSchema } from "@winston/db/config";
import { loadConfig } from "@winston/shared/config";
import { logConfigSchema } from "@winston/shared/logger";
import { tokenVaultConfigSchema } from "@winston/shared/token-vault";
import { z } from "zod";

const agentsConfigSchema = dbConfigSchema
  .extend({
    ...logConfigSchema.shape,
    /** Opens connected accounts' tokens (KMS in production). */
    ...tokenVaultConfigSchema.shape,
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
    /** Where users' VMs run: local Docker containers, or EC2 in production. */
    VM_PROVIDER: z.enum(["docker", "ec2"]).default("docker"),
    /** The image local VMs run (`bun run image:build:local`). */
    VM_IMAGE: z.string().min(1).default("winston-vm:local"),
    /**
     * When VMs move onto a new image, in each user's time zone, as
     * "from-to" hours. Defaults: 3-5 (the quiet hours) on EC2, any time
     * locally.
     */
    VM_ROLLOUT_HOURS: z
      .string()
      .regex(/^\d{1,2}-\d{1,2}$/, "hours as from-to, e.g. 3-5")
      .optional(),
    /** EC2: the Vm stack's launch template, and the public subnets VMs launch in. */
    EC2_LAUNCH_TEMPLATE: z.string().min(1).default("winston-vm"),
    EC2_SUBNET_IDS: z
      .string()
      .optional()
      .transform((value) => value?.split(",").filter(Boolean) ?? []),
    /** Where `winstond` dials the gateway: from inside a local container, or wss://gateway.runwinston.com. */
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
    /** The local site host's admin API (bun dev's sites service, §9a): taking a deleted account's sites down. */
    SITES_ADMIN_URL: z.url().optional(),
    /** The S3 bucket for images and other binaries (production). */
    BLOB_BUCKET: z.string().min(1).optional(),
    /** Local blob storage, used when BLOB_BUCKET isn't set. */
    BLOB_DIR: z
      .string()
      .min(1)
      .default(new URL("../../../.data/blobs", import.meta.url).pathname),
    /** Where SES writes mail for Winston's addresses (production; docs/runbooks/email.md). */
    INBOUND_MAIL_BUCKET: z.string().min(1).optional(),
    /** Locally, where `bun run mail:receive` leaves messages instead. */
    INBOUND_MAIL_DIR: z
      .string()
      .min(1)
      .default(
        new URL("../../../.data/inbound-mail", import.meta.url).pathname,
      ),
    /** The OAuth client connected accounts were granted to: refreshing their tokens. */
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
    /** Where Gmail publishes changes (`projects/<id>/topics/gmail-push`); mail isn't watched without it. */
    GMAIL_PUSH_TOPIC: z.string().min(1).optional(),
    /** Our calendar webhook, where Google Calendar channels push (HTTPS with a valid certificate); calendars aren't watched without it. */
    CALENDAR_PUSH_URL: z.url().optional(),
    /** Where the site is served, for links Winston sends (like reconnecting an account). */
    WEB_PUBLIC_URL: z.url().default("http://localhost:3002"),
    /** How many jobs this process runs at once, besides background steps. */
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
    /**
     * How many background-run steps this process runs at once, in their own
     * pool so they never hold up a reply. Steps mostly wait on the model or
     * the VM, so this can be generous.
     */
    BACKGROUND_CONCURRENCY: z.coerce.number().int().positive().default(16),
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
  )
  .refine(
    (config) =>
      config.VM_PROVIDER !== "ec2" || config.EC2_SUBNET_IDS.length > 0,
    { path: ["EC2_SUBNET_IDS"], message: "required when VM_PROVIDER is ec2" },
  );

export function loadAgentsConfig() {
  return loadConfig(agentsConfigSchema);
}
