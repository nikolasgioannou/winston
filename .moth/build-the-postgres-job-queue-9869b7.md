---
id: "9869b7"
title: Build the Postgres job queue
status: todo
priority: none
labels:
  - backend
  - db
  - m1
created_at: 2026-09-27T05:30:54.140Z
updated_at: 2026-09-27T05:30:54.219Z
blocked_by:
  - "2c5ac8"
  - "5b4554"
  - "9378a8"
  - "fc638d"
---

All asynchronous work in Winston runs through one job table in Postgres (docs/design.md §9 and the job state machine in §17): front-of-house turns, agent steps, syncs, trigger firings and provisioning. Getting this right matters, because deploys and crashes must never lose work.

Implement in `packages/db` (or a small `packages/queue`, if that reads better):
- The `jobs` table (§14): `type`, `payload`, `run_at`, `locked_until`, `attempts`, `max_attempts`, `status`, a nullable unique `dedupe_key`, and `last_error`.
- `enqueue(type, payload, { runAt, dedupeKey, maxAttempts })`, usable **inside a caller's transaction**, so "save the message and enqueue the turn" is atomic.
- `lease(types, workerId, leaseMs)` using `SELECT … FOR UPDATE SKIP LOCKED`, picking due jobs (`run_at <= now()`) and setting `locked_until`.
- `complete`, `fail` (retry with exponential backoff plus jitter until `max_attempts`, then `failed`), and `extendLease` for long steps.
- An expired lease makes the job leasable again. That's how a crashed worker's job gets picked up.
- Dedupe semantics: enqueueing with an existing *queued* `dedupe_key` should be able to either no-op or push `run_at` later. The front-of-house debounce needs the latter, so design the API for both.

Research the edge cases people hit with SKIP LOCKED queues (index design on `(status, run_at)`, lease clock skew by relying on the database's `now()`, vacuum churn on hot tables) and handle the important ones.

Tests, against real Postgres:
- Two concurrent workers never lease the same job.
- An expired lease is re-leased.
- Retries back off and stop at `max_attempts`.
- Dedupe behaves as designed.
- Enqueue inside a rolled-back transaction leaves no job.
