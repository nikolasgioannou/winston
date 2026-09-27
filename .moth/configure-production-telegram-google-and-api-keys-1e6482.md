---
id: "1e6482"
title: Configure production Telegram, Google and API keys (with the founder)
status: todo
priority: none
labels:
  - collab
  - infra
  - m4
created_at: 2026-09-27T05:36:33.346Z
updated_at: 2026-09-27T05:36:33.416Z
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
