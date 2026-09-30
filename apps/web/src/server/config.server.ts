import { dbConfigSchema } from "@winston/db/config";
import { loadConfig } from "@winston/shared/config";
import { z } from "zod";

const webConfigSchema = dbConfigSchema.extend({
  /** The Google OAuth client for this environment (docs/runbooks/google-cloud.md). */
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  /**
   * Where the site is served. Builds the sign-in redirect URI, and https
   * makes cookies Secure.
   */
  WEB_PUBLIC_URL: z.url().default("http://localhost:3002"),
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
