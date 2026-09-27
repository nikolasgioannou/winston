---
id: "70194e"
title: Receive Gmail push notifications and keep watches alive
status: todo
priority: none
labels:
  - connectors
  - events
  - m7
created_at: 2026-09-27T05:40:24.374Z
updated_at: 2026-09-27T05:40:24.428Z
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
