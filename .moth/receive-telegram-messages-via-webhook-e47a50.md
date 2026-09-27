---
id: "e47a50"
title: Receive Telegram messages via webhook
status: todo
priority: none
labels:
  - backend
  - m1
  - telegram
created_at: 2026-09-27T05:30:54.448Z
updated_at: 2026-09-27T18:08:36.918Z
blocked_by:
  - "76c143"
  - "9869b7"
  - "c5850d"
---

This is the start of the conversation path. Telegram posts updates to `api`, and each one becomes a structured `inbound_items` row plus a queued front-of-house turn, **in one transaction** (docs/design.md §4, §9).

Research grammY in depth first:
- Running in webhook mode inside an existing Hono app, rather than letting grammY own the server.
- Verifying Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
- Handling update types and choosing `allowed_updates`.
- Telegram's retry behaviour when we're slow or erroring (so we respond fast and do work in jobs).
- Idempotency: Telegram can redeliver the same `update_id`.

Behaviour:
- Reject requests without the correct secret token.
- Ignore anything that isn't a private chat. Ignore private chats that aren't linked to a user (a polite one-line reply is fine, but never process them).
- For text messages, store a `user_message` item with the text, `sent_at`, Telegram message id, reply-to message id (if replying), and **forward origin** when forwarded, so Winston knows who originally sent it (product.md §2).
- Deduplicate on Telegram's `update_id`.
- Enqueue a `front_turn` job for the user with a short debounce (~1.5 s), using the dedupe key so a burst of messages produces one turn. Coordinate with the serialization ticket, which will refine this.

Also add a `bun run telegram:webhook` script that registers the webhook (URL from the tunnel base URL, plus the secret) for the configured bot and shows its current status.

Tests: webhook handler unit tests with fixture updates (text, reply, forwarded, group chat, unknown chat, duplicate update, bad secret).

Also document in `docs/local-dev.md` how to find your Telegram chat id for `SEED_TELEGRAM_CHAT_ID` (deferred from `762cf0`), for example by messaging the dev bot and reading the update with a `getUpdates` call before the webhook is set.
