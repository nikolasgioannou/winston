---
id: "16b185"
title: Reconcile connections periodically
status: todo
priority: none
labels:
  - connectors
  - events
  - m7
created_at: 2026-09-27T05:40:24.637Z
updated_at: 2026-09-27T05:40:24.690Z
blocked_by:
  - "6a3656"
  - "f81278"
---

Google push notifications occasionally get lost. A slow reconciliation sync per connection, every ~10 minutes, catches anything missed (docs/design.md §3, Reconciliation backstop). Because the checkpoints (`historyId`, `syncToken`) live in Postgres and events have dedupe keys, running a sync that finds nothing new is harmless.

Build a `reconcile_connections` job that enqueues `sync_connection` for every healthy connection (skipping expired or disconnected ones), reusing the same dedupe key as push-triggered syncs, so a reconcile never piles up behind a push sync. Spread connections across the interval rather than hitting them all at once. Also verify watches and channels exist and aren't about to lapse, and heal them if they're missing, since a missed renewal would otherwise silently kill push.

Tests: skipping unhealthy connections, the dedupe interplay with push syncs, and healing a missing watch.
