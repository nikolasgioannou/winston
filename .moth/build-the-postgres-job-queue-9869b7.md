---
id: "9869b7"
title: Build the Postgres job queue
status: done
priority: none
labels:
  - backend
  - db
  - m1
created_at: 2026-09-27T05:30:54.140Z
updated_at: 2026-09-27T18:54:12.771Z
blocked_by:
  - "2c5ac8"
  - "5b4554"
  - "9378a8"
  - "fc638d"
---

All asynchronous work in Winston runs through one job table in Postgres (docs/design.md §9, and the job state machine in §17): front-of-house turns, agent steps, syncs, trigger firings and provisioning. Deploys and crashes must never lose work.

Research: pitfalls of `SKIP LOCKED` queues. Findings applied:
- Lease in one short statement, and do the work outside any transaction.
- Use the database's clock for all timing.
- Partial indexes for due queued jobs and for running leases.
- **Guard completion with a per-lease token**, so a stale worker can't overwrite a job another worker re-leased.
- Dead-tuple bloat only matters at hundreds of jobs per second. Noted in the design doc, not built for.

`@winston/db/queue`, with the `jobs` table:
- `enqueue(db, type, { payload, userId, runAt, maxAttempts, dedupeKey, onDuplicate })` works inside a caller's transaction. A dedupe key allows at most one *queued* job per key. `onDuplicate: "ignore"` leaves the existing job alone, and `"reschedule"` moves its run time (the debounce). The key frees up once the job starts running.
- `lease(db, { types, leaseMs, limit })` returns `{ job, token }` leases. Expired leases are leasable again.
- `complete`, `fail` (exponential backoff with jitter until `maxAttempts`, then `failed`) and `extendLease` all require the current lease token, and return false if the lease was lost.
- `retryDelayMs(attempts)` is pure and tested.

Tests, against real Postgres:
- Enqueue in a rolled-back transaction leaves no job.
- Dedupe `ignore` and `reschedule` behave as designed, and a running job frees its key.
- Only due jobs of the requested types are leased.
- Four concurrent workers never lease the same job (20 jobs, all distinct).
- An expired lease is re-leased, and the stale worker can't complete or extend it.
- `extendLease` prevents a re-lease.
- Failures retry with backoff, then stop at `maxAttempts`.
