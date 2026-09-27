---
id: "762cf0"
title: Add identity tables and a dev seed script
status: done
priority: none
labels:
  - db
  - m1
created_at: 2026-09-27T05:30:53.971Z
updated_at: 2026-09-27T18:08:36.935Z
blocked_by:
  - "2c5ac8"
  - "5b4554"
---

**Order note:** this comes right after Drizzle and before the Postgres test harness, so the harness has real tables to prove itself on. The seed-idempotency and constraint tests described below are written in the harness ticket (`fc638d`).

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

`SEED_TELEGRAM_CHAT_ID` is optional. How to find your chat id is documented by the Telegram webhook ticket (`e47a50`), once a dev bot exists. The seed refuses any database that isn't on `localhost`/`127.0.0.1`, which is a real guard today, with no environment-name setting needed.

Also done here: the id prefix registry in `packages/db/src/ids.ts` (`idPrefixes`, `newId`, with a uniqueness test), migrations named with `--name`, Prettier ignoring `packages/db/migrations/`, the `SEED_*` values in `.env.example`, and `scripts/setup.sh` applying migrations and seeding once configured.

Tests: the seed is idempotent (running it twice leaves one row of each), and uniqueness constraints hold.
