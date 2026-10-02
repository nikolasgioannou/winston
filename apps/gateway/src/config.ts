import { dbConfigSchema } from "@winston/db/config";
import { loadConfig } from "@winston/shared/config";
import { logConfigSchema } from "@winston/shared/logger";
import { tokenVaultConfigSchema } from "@winston/shared/token-vault";
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
  /** Production: the bucket VM binaries are published to (self-update). */
  ARTIFACTS_BUCKET: z.string().min(1).optional(),
  GATEWAY_INTERNAL_SECRET: z
    .string()
    .regex(/^[\w-]{32,}$/, "expected at least 32 letters, digits, _ or -"),
  /** Jev for the browser's autopilot, served by OpenRouter (§5). Optional: without it, autopilot is off. */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
});

export function loadGatewayConfig() {
  return loadConfig(gatewayConfigSchema);
}
