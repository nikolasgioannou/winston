# Production secrets

Winston's production secrets live in AWS Secrets Manager in `winston-prod`, named `winston/<name>`. The Services stack creates them (`infra/src/secrets.ts`), and `serviceSecrets` there says which service sees which; ECS injects each service's own as environment variables when a task starts (docs/design.md §12a). Values never go in the repo, a commit, a ticket or a chat.

Log in first (docs/runbooks/aws-access.md):

```sh
aws sso login --profile winston-prod
export AWS_PROFILE=winston-prod
```

## The secrets

| Secret                            | Value                                                                                                          | Services             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- |
| `winston/telegram-bot-token`      | @RunWinstonBot's token, from @BotFather                                                                        | api, agents          |
| `winston/telegram-webhook-secret` | generated at creation                                                                                          | api                  |
| `winston/openrouter-api-key`      | the production OpenRouter key (models, and Jev for the browser's autopilot)                                    | agents, gateway      |
| `winston/google-oauth`            | JSON `{"clientId": "…", "clientSecret": "…"}`, the "Winston production" client (docs/runbooks/google-cloud.md) | web, gateway, agents |
| `winston/gateway-internal-secret` | generated at creation                                                                                          | agents, gateway      |
| `winston/run-token-secret`        | generated at creation                                                                                          | agents, gateway      |

Every secret starts with a random 48-character value, so the generated ones are ready as they are and the others hold a placeholder until they're set. Database credentials aren't here: RDS manages and rotates them (the `rds!db-…` secret). Connected accounts' tokens are encrypted with the KMS key `alias/winston/tokens`, not stored as secrets.

## Setting the external keys (the easy way)

```sh
aws sso login --profile winston-prod
bun run prod:keys
```

It asks for @RunWinstonBot's token, the production OpenRouter key, and the "Winston production" Google client's id and secret, with typing hidden (leave one blank to keep it), stores them, restarts the services that read them, and, once `api.runwinston.com` resolves, registers the bot's webhook at `https://api.runwinston.com/webhooks/telegram` with the generated webhook secret and prints Telegram's webhook info (`allowed_updates` includes reactions). Re-run just the webhook with `bun run prod:keys --webhook`.

## Setting a value

Read the value from a prompt or a file, so it doesn't land in your shell history:

```sh
read -rs VALUE && aws secretsmanager put-secret-value --secret-id winston/openrouter-api-key --secret-string "$VALUE"; unset VALUE
```

For `winston/google-oauth`, write the JSON to a temporary file, then:

```sh
aws secretsmanager put-secret-value --secret-id winston/google-oauth --secret-string file://google-oauth.json && rm google-oauth.json
```

Running tasks keep the old value until they restart, so restart the services that use it (see the table): `aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment`.

## Rotating

- **A generated secret:** set a new random value, then restart every service that uses it at once.
  ```sh
  aws secretsmanager put-secret-value --secret-id winston/run-token-secret \
    --secret-string "$(aws secretsmanager get-random-password --exclude-punctuation --password-length 48 --query RandomPassword --output text)"
  ```
  - `gateway-internal-secret` and `run-token-secret` are shared by agents and the gateway: calls fail between the two restarts, so do it at a quiet time.
  - `telegram-webhook-secret`: after the restart, register the webhook again so Telegram sends the new value (`bun run prod:keys --webhook`).
- **An external secret** (bot token, OpenRouter key, Google client): create the new credential with the provider, set it as above, restart, then revoke the old one.
- **Checking a value** without printing it: `aws secretsmanager get-secret-value --secret-id <name> --query 'length(SecretString)'`.
