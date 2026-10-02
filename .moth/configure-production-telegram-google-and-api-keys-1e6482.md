---
id: "1e6482"
title: Configure production Telegram, Google and API keys (with the founder)
status: done
priority: none
labels:
  - collab
  - infra
  - m4
created_at: 2026-09-27T05:36:33.346Z
updated_at: 2026-10-02T04:30:03.333Z
blocked_by:
  - "071e49"
  - "2ca5a6"
  - "ef5b35"
---

Before the first real production use, the external services need their production settings. Most of these happen in the founder's accounts, so do them together:
- **Telegram:** use @RunWinstonBot's token (production). Set the secrets in Secrets Manager. Run the webhook registration script against `https://api.runwinston.com/…` with the production secret, and confirm with `getWebhookInfo`, including `allowed_updates` for reactions.
- **Google:** in the production OAuth client, add the production redirect URIs. On the consent screen, set the homepage, privacy and terms URLs now that they're live. Confirm the founder's accounts are test users.
- **OpenRouter and TypeSafe:** production API keys, separate from dev keys, so spend is tracked separately.
- **Session, run-token and internal secrets:** generate strong random values and set them.

Update the runbooks with anything learned. Done when every production secret has a real value and the external dashboards show the production endpoints.

**Progress (2026-10-01):** everything that doesn't need the founder is ready: `bun run prod:keys` asks for the bot token, OpenRouter key and Google client (hidden input), stores them, restarts the affected services and registers the webhook once `api.runwinston.com` resolves. The generated secrets (webhook, run-token, internal) already hold strong random values. There's no session secret (sessions are Postgres rows), no Jev key yet (M8), and no consent-screen homepage/privacy/terms (no public pages while Winston is for friends, docs/design.md §9).

**Left for the founder:** add the `api` and `gateway` CNAMEs and the apex (docs/runbooks/dns.md), make sure @RunWinstonBot exists in @BotFather, create the production OpenRouter key (with a credit limit, docs/runbooks/costs.md), then run `aws sso login --profile winston-prod && bun run prod:keys`.

**Done (2026-10-02):** the founder added the DNS records and ran `bun run prod:keys` (bot token, OpenRouter production key with a $150 monthly limit, the Google production client); the webhook is registered at api.runwinston.com with reactions in `allowed_updates`. The OpenRouter spend and low-balance alerts were left for later, the founder's call. `prod:keys` was fixed to restart every service that reads a changed key (the gateway was missed once).

