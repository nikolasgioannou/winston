import { RemovalPolicy } from "aws-cdk-lib";
import { Secret as EcsSecret } from "aws-cdk-lib/aws-ecs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

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
  },
  gateway: {
    GATEWAY_INTERNAL_SECRET: "gateway-internal-secret",
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

/** The Secrets Manager secrets, and each service's ECS secret environment. */
export class Secrets extends Construct {
  readonly byName: Record<SecretName, Secret>;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const entries = Object.entries(secrets).map(([name, { generated }]) => [
      name,
      new Secret(this, name, {
        secretName: `winston/${name}`,
        description: generated
          ? "Generated at creation"
          : "Set out of band (docs/runbooks/secrets.md)",
        // Letters and digits, the format the services' configs accept.
        generateSecretString: { excludePunctuation: true, passwordLength: 48 },
        removalPolicy: RemovalPolicy.RETAIN,
      }),
    ]);
    this.byName = Object.fromEntries(entries) as Record<SecretName, Secret>;
  }

  /** The secrets a service's task definition injects, by variable name. */
  environmentFor(service: Service): Record<string, EcsSecret> {
    return Object.fromEntries(
      Object.entries(serviceSecrets[service] as Record<string, SecretRef>).map(
        ([variable, ref]) => {
          const [name, field] = typeof ref === "string" ? [ref] : ref;
          return [
            variable,
            EcsSecret.fromSecretsManager(this.byName[name], field),
          ];
        },
      ),
    );
  }
}
