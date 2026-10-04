/**
 * Production's secrets and which service reads which, as plain data with no
 * CDK imports, so scripts (`bun run prod:keys`) can use the same table as the
 * stack.
 */
/**
 * Every production secret (docs/design.md §12a), named `winston/<name>`.
 * Internal secrets get a random value at creation; the others are set out of
 * band (docs/runbooks/secrets.md). Database credentials aren't here: RDS
 * manages them (the Data stack).
 */
export const secrets = {
  "telegram-bot-token": { generated: false },
  /**
   * SHA-256 of the bot token, in hex: checks Telegram sign-in buttons'
   * signatures without being able to act as the bot. `prod:keys` derives it.
   */
  "telegram-login-key": { generated: false },
  /** Our own value, handed to Telegram when the webhook is set. */
  "telegram-webhook-secret": { generated: true },
  "openrouter-api-key": { generated: false },
  /** JSON: `{ "clientId": "…", "clientSecret": "…" }`. */
  "google-oauth": { generated: false },
  "gateway-internal-secret": { generated: true },
  "run-token-secret": { generated: true },
  /**
   * Signs the passes that open private sites (docs/design.md §9a); any long
   * random secret works, so the generated one does. The dispatch Worker gets
   * its public half at deploy (`bun run sites:deploy-dispatch`).
   */
  "sites-pass-key": { generated: true },
  /** The backend's Cloudflare token (docs/runbooks/sites.md); `prod:keys` sets it. */
  "cloudflare-api-token": { generated: false },
} as const;

export type SecretName = keyof typeof secrets;

/** An environment variable's secret, or one field of a JSON secret. */
export type SecretRef = SecretName | readonly [SecretName, string];

/**
 * Which service sees which secret, as the environment variables its config
 * reads. A service gets nothing that isn't listed here.
 */
export const serviceSecrets = {
  api: {
    TELEGRAM_BOT_TOKEN: "telegram-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret",
  },
  agents: {
    OPENROUTER_API_KEY: "openrouter-api-key",
    TELEGRAM_BOT_TOKEN: "telegram-bot-token",
    GATEWAY_INTERNAL_SECRET: "gateway-internal-secret",
    RUN_TOKEN_SECRET: "run-token-secret",
    // Refreshing connected accounts' tokens for watches and syncs (§3).
    GOOGLE_OAUTH_CLIENT_ID: ["google-oauth", "clientId"],
    GOOGLE_OAUTH_CLIENT_SECRET: ["google-oauth", "clientSecret"],
    // Sites' usage, the kill switch, and taking a deleted account's sites down (§9a).
    CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
  },
  gateway: {
    GATEWAY_INTERNAL_SECRET: "gateway-internal-secret",
    // Jev for the browser's autopilot, through OpenRouter (§5).
    OPENROUTER_API_KEY: "openrouter-api-key",
    RUN_TOKEN_SECRET: "run-token-secret",
    // Trading connected accounts' refresh tokens for access tokens (mail, calendar).
    GOOGLE_OAUTH_CLIENT_ID: ["google-oauth", "clientId"],
    GOOGLE_OAUTH_CLIENT_SECRET: ["google-oauth", "clientSecret"],
    // Deploying sites, and checking them as their owner (§9a).
    CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
    SITES_PASS_KEY: "sites-pass-key",
  },
  web: {
    GOOGLE_OAUTH_CLIENT_ID: ["google-oauth", "clientId"],
    GOOGLE_OAUTH_CLIENT_SECRET: ["google-oauth", "clientSecret"],
    // Checking Telegram sign-in buttons' signatures (§13), not the bot's token.
    TELEGRAM_LOGIN_KEY: "telegram-login-key",
    // The Sites page's changes, and the passes that open private sites (§9a).
    CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
    SITES_PASS_KEY: "sites-pass-key",
  },
} as const satisfies Record<string, Record<string, SecretRef>>;

export type Service = keyof typeof serviceSecrets;
