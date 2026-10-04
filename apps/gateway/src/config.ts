import { dbConfigSchema } from "@winston/db/config";
import { loadConfig } from "@winston/shared/config";
import { logConfigSchema } from "@winston/shared/logger";
import { tokenVaultConfigSchema } from "@winston/shared/token-vault";
import { siteHostConfigSchema } from "@winston/site-host/config";
import { z } from "zod";

const gatewayConfigSchema = dbConfigSchema.extend({
  ...logConfigSchema.shape,
  GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
  /** Local VMs dial ws://host.docker.internal:3001 (`VM_GATEWAY_URL` in agents). */
  GATEWAY_PORT: z.coerce.number().int().positive().default(3001),
  /**
   * The address agents reaches this gateway at, recorded on the VMs it
   * holds. Defaults to the machine's own private address (an ECS task's).
   */
  GATEWAY_ADVERTISE_URL: z.url().optional(),
  /** Authenticates `agents` to the internal API. Never exposed publicly. */
  /** Verifies WINSTON_RUN_TOKENs (agents signs them with the same secret). */
  RUN_TOKEN_SECRET: z
    .string()
    .regex(/^[\w-]{32,}$/, "expected at least 32 letters, digits, _ or -"),
  /** Opens connected accounts' tokens for mail and calendar calls (KMS in production). */
  ...tokenVaultConfigSchema.shape,
  /** The Google OAuth client, for trading refresh tokens for access tokens. */
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  /** The site, for links in errors (permission toggles, reconnecting). */
  WEB_PUBLIC_URL: z.url().default("http://localhost:3002"),
  /** Production: the blobs bucket (Winston's raw mail: attachments, and what he sends). */
  BLOB_BUCKET: z.string().min(1).optional(),
  /** Locally: agents' blob directory, used when BLOB_BUCKET isn't set. */
  BLOB_DIR: z
    .string()
    .min(1)
    .default(new URL("../../../.data/blobs", import.meta.url).pathname),
  /** Production: SES's configuration set for Winston's own mail; without it, sending is only logged. */
  SES_CONFIGURATION_SET: z.string().min(1).optional(),
  /** Production: the bucket VM binaries are published to (self-update). */
  ARTIFACTS_BUCKET: z.string().min(1).optional(),
  GATEWAY_INTERNAL_SECRET: z
    .string()
    .regex(/^[\w-]{32,}$/, "expected at least 32 letters, digits, _ or -"),
  /** Where sites run (§9a): Cloudflare, or bun dev's sites service. Without either, deploying sites is unavailable. */
  ...siteHostConfigSchema.shape,
  /** Where sites are served, each at a subdomain: https://runwinston.app. */
  SITES_PUBLIC_URL: z.url().default("http://sites.localhost:3003"),
  /** Signs the passes `winston site fetch` opens private sites with: the same key the site signs with. */
  SITES_PASS_KEY: z
    .string()
    .regex(/^[\w-]{32,}$/, "expected at least 32 letters, digits, _ or -")
    .optional(),
  /** Locally, where site fetches connect (bun dev's sites service), since `*.sites.localhost` doesn't resolve. */
  SITES_CONNECT_URL: z.url().optional(),
  /** The S3 bucket for sites' bundles and other binaries (production). */
  BLOB_BUCKET: z.string().min(1).optional(),
  /** Local blob storage, used when BLOB_BUCKET isn't set. */
  BLOB_DIR: z
    .string()
    .min(1)
    .default(new URL("../../../.data/blobs", import.meta.url).pathname),
  /** Jev and its helpers for `winston browser act`, served by OpenRouter (§5). Optional: without it, act can't decide steps. */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
});

export function loadGatewayConfig() {
  return loadConfig(gatewayConfigSchema);
}
