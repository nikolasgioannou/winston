---
id: "fc638d"
title: Build a Postgres-backed test harness
status: todo
priority: none
labels:
  - db
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.540Z
updated_at: 2026-09-27T16:41:15.557Z
blocked_by:
  - "2c5ac8"
  - "5b4554"
---

A lot of the logic that matters most runs inside Postgres: the job queue's `SKIP LOCKED` leasing, trigger matching, full-text search, the append-only logs. Those tests must hit a real Postgres, not mocks (docs/design.md §8b).

Build a harness that tests import:
- It runs migrations once against the `winston_test` database per test run (a preload file or global setup).
- Each test gets isolation. Research the trade-offs: wrapping each test in a transaction that rolls back is fastest, but it breaks tests that need concurrent connections, such as two workers racing for the same job. Support both: a default transactional fixture, plus a `truncateAll()` escape hatch for concurrency tests.
- Small factory helpers for inserting rows (they grow as tables arrive).

Make it fail fast and clearly when Docker Postgres isn't running ("start it with `bun run db:up`"). The pre-commit hook will run these tests, so a cryptic connection error there would be miserable.

Update `docs/testing.md` with how to write a DB test. Add the DB tests to the root `test` script and to the lefthook pre-commit hook. Include one real test proving isolation: a row inserted in one test is not visible in the next.
