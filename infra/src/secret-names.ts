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
  /** Our own value, handed to Telegram when the webhook is set. */
  "telegram-webhook-secret": { generated: true },
  "openrouter-api-key": { generated: false },
  /** JSON: `{ "clientId": "…", "clientSecret": "…" }`. */
  "google-oauth": { generated: false },
  "gateway-internal-secret": { generated: true },
  "run-token-secret": { generated: true },
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
  },
  gateway: {
    GATEWAY_INTERNAL_SECRET: "gateway-internal-secret",
    // Jev for the browser's autopilot, through OpenRouter (§5).
    OPENROUTER_API_KEY: "openrouter-api-key",
    RUN_TOKEN_SECRET: "run-token-secret",
    // Trading connected accounts' refresh tokens for access tokens (mail, calendar).
    GOOGLE_OAUTH_CLIENT_ID: ["google-oauth", "clientId"],
    GOOGLE_OAUTH_CLIENT_SECRET: ["google-oauth", "clientSecret"],
  },
  web: {
    GOOGLE_OAUTH_CLIENT_ID: ["google-oauth", "clientId"],
    GOOGLE_OAUTH_CLIENT_SECRET: ["google-oauth", "clientSecret"],
  },
} as const satisfies Record<string, Record<string, SecretRef>>;

export type Service = keyof typeof serviceSecrets;
