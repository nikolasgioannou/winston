---
id: "5cbe5b"
title: Create the agents service worker loop
status: done
priority: none
labels:
  - agents
  - backend
  - m1
created_at: 2026-09-27T05:30:54.234Z
updated_at: 2026-09-27T18:58:51.833Z
blocked_by:
  - "2c5ac8"
  - "9869b7"
---

`apps/agents` runs front-of-house turns and background-agent steps by pulling jobs from the queue (docs/design.md §9). This ticket builds the process shell, with no agent logic yet.

- **Config** (`LOG_LEVEL`, `WORKER_CONCURRENCY`, `SHUTDOWN_TIMEOUT_MS`, plus `DATABASE_URL` from `@winston/db/config`), a logger and a DB pool.
- **`createWorker({ db, logger, handlers, concurrency })`:**
  - Leases only the registered job types, up to `concurrency` at a time.
  - Gives each handler `{ job, db, logger (tagged with jobId, type and user), extendLease }`.
  - Completes or fails each job with its lease.
  - Survives database errors while leasing (it logs, pauses and retries).
- **Graceful shutdown:** SIGTERM or SIGINT stops leasing, waits for in-flight handlers, closes the pool and exits 0. A second signal, or the timeout, exits immediately. Leases recover anything cut short.
- **No job handlers are registered yet.** The front-of-house turn ticket adds the first one.
- **The ECS health check** is noted for M4 rather than built now, since nothing runs on Fargate yet.

Tests, with real Postgres and test-only handlers:
- A job runs and is marked done.
- `stop()` lets the in-flight job finish, and leases nothing new.
- A throwing handler records the failure for a retry.
- `concurrency` is never exceeded.
- Unregistered types are ignored.

Also verified by hand: the real process starts, and exits 0 on SIGTERM with the expected log lines.
