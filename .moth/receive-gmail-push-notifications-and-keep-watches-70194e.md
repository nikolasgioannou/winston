---
id: "70194e"
title: Receive Gmail push notifications and keep watches alive
status: done
priority: none
labels:
  - connectors
  - events
  - m7
created_at: 2026-09-27T05:40:24.374Z
updated_at: 2026-10-01T19:05:09.418Z
blocked_by:
  - "9751a9"
  - "9c407f"
---

Gmail tells us "something changed" through Pub/Sub. We verify the push, then sync (docs/design.md §3, How change notifications arrive).

Build:
- **`POST /webhooks/gmail` in `api`:** verify the Pub/Sub **OIDC token** (issuer, audience, service account email; research the verification with Google's certs). Decode the message (`emailAddress`, `historyId`), find the matching mail connection, and enqueue a `sync_connection` job **deduped per connection**, so a burst of notifications produces one sync. Respond 2xx quickly. Unknown addresses get acked and ignored.
- **Watches:** when a mail connection is created (or reconnected), call `users.watch` for INBOX and SENT with label changes. Store `watch_expires_at`. A `renew_watches` job runs **daily** and renews anything expiring within ~2 days (watches last 7). On disconnect, call `users.stop`.
- **Dev:** the dev topic's push subscription points at the tunnel, so this works locally too.

Tests: OIDC verification (valid, wrong audience, expired, wrong issuer), dedupe of bursts into one job, renewal selection logic, and watch/stop calls on connect and disconnect with a mocked API.

## As built

- Webhook and OIDC verification in `apps/api` (`jose` 6, offline against Google's JWKS); watches, renewal and stop in `apps/agents/src/connections/`; `gmailSync` (watch, stop) in `@winston/connectors/gmail-sync`. Details in docs/design.md §3.
- `agents` now gets the Google client secret (it refreshes connected accounts' tokens for watches and syncs) and `GMAIL_PUSH_TOPIC`; `api` gets `GMAIL_PUSH_AUDIENCE` and `GMAIL_PUSH_SERVICE_ACCOUNT`. Production values are in the Services stack.
- Renewal is an hourly sweep that renews anything ending within 2 days (rather than a once-a-day job), which also picks up connections whose first watch failed.
- It works live once 9751a9's Terraform is applied; until then watches are refused and logged, and the webhook gets no pushes.

