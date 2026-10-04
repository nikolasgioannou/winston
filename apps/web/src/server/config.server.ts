import { dbConfigSchema } from "@winston/db/config";
import { tokenVaultConfigSchema } from "@winston/shared/token-vault";
import { loadConfig } from "@winston/shared/config";
import { siteHostConfigSchema } from "@winston/site-host/config";
import { z } from "zod";

const webConfigSchema = dbConfigSchema
  .extend(tokenVaultConfigSchema.shape)
  // Where sites run (§9a): the Sites page's changes.
  .extend(siteHostConfigSchema.shape)
  .extend({
    /** The Google OAuth client for this environment (docs/runbooks/google-cloud.md). */
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
    /**
     * Where the site is served. Builds the sign-in redirect URI, and https
     * makes cookies Secure.
     */
    WEB_PUBLIC_URL: z.url().default("http://localhost:3002"),
    /** The gateway's address for the browser page's live views (§5): wss://gateway.runwinston.com. */
    GATEWAY_PUBLIC_URL: z.url().default("ws://localhost:3001"),
    /**
     * SHA-256 of the bot token, in hex: checks Telegram sign-in buttons'
     * signatures (§13). Without it (or with a wrong one) they fall back to
     * signing in with Google.
     */
    TELEGRAM_LOGIN_KEY: z.string().min(1).optional(),
    /**
     * Signs site passes (docs/design.md §9a): a long random secret, hashed
     * into an Ed25519 key. Without it, private sites can't be opened.
     */
    SITES_PASS_KEY: z
      .string()
      .regex(/^[\w-]{32,}$/, "expected at least 32 letters, digits, _ or -")
      .optional(),
    /** Where sites are served, each at a subdomain: https://runwinston.app. */
    SITES_PUBLIC_URL: z.url().default("http://sites.localhost:3003"),
    /** Sites' bundles, for rollback: S3 in production, a directory locally. */
    BLOB_BUCKET: z.string().min(1).optional(),
    BLOB_DIR: z
      .string()
      .min(1)
      .default(new URL("../../../../.data/blobs", import.meta.url).pathname),
    /** The bot Connect Telegram opens: @RunWinstonBot in production. */
    TELEGRAM_BOT_USERNAME: z
      .string()
      .regex(/^\w{5,32}$/, "expected a bot username without the @")
      .default("RunWinstonDevBot"),
  });

let config: Readonly<z.output<typeof webConfigSchema>> | undefined;

/** The site's server config, read on first use (never in the browser). */
export function webConfig() {
  return (config ??= loadConfig(webConfigSchema));
}
