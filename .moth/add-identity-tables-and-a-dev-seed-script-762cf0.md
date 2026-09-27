---
id: "762cf0"
title: Add identity tables and a dev seed script
status: todo
priority: none
labels:
  - db
  - m1
created_at: 2026-09-27T05:30:53.971Z
updated_at: 2026-09-27T05:30:54.032Z
blocked_by:
  - "2c5ac8"
  - "5b4554"
  - "fc638d"
---

M1 is about talking to Winston before sign-up exists. So the founder's user record, allowlist entry and Telegram link are created by a seed script rather than by the web app (docs/design.md §8d).

Add the identity tables from §14 to `packages/db`:
- `users`: `first_name`, `last_name`, `email` unique, `timezone` as an IANA string.
- `allowed_emails`.
- `telegram_links`, with `chat_id` unique.

`web_sessions` and `telegram_link_tokens` belong to M3. Leave them out, so this migration contains only what's used now. Use the prefixed id helpers for primary keys.

Write `bun run db:seed` (idempotent, local only):
- Upserts a user from env vars (`SEED_EMAIL`, `SEED_FIRST_NAME`, `SEED_LAST_NAME`, `SEED_TIMEZONE`).
- Adds that email to `allowed_emails`.
- Links `SEED_TELEGRAM_CHAT_ID`.

Document in `docs/local-dev.md` how to find your Telegram chat id: message the dev bot and read the update, for example with a tiny `getUpdates` call before a webhook is set. The seed must refuse to run when the environment is `production`.

Tests: the seed is idempotent (running it twice leaves one row of each), and uniqueness constraints hold.
