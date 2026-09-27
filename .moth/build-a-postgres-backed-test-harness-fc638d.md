---
id: "fc638d"
title: Build a Postgres-backed test harness
status: done
priority: none
labels:
  - db
  - m1
  - tooling
created_at: 2026-09-27T05:28:45.540Z
updated_at: 2026-09-27T18:19:30.998Z
blocked_by:
  - "2c5ac8"
  - "5b4554"
  - "762cf0"
---

A lot of the logic that matters most runs inside Postgres: the job queue's `SKIP LOCKED` leasing, trigger matching, full-text search, the append-only logs. Those tests must hit a real Postgres, not mocks (docs/design.md §8b). This ticket comes right after the identity tables, so its first real tests are theirs.

Build `@winston/db/testing`:
- **`testDb()`:** creates the `winston_test` database if it's missing (deferred from the Postgres ticket), applies migrations once per test run, and returns a client. It **fails fast** with "Can't reach Postgres … Start it with ./scripts/setup.sh (or bun run db:up)", because the pre-commit hook runs these tests. It refuses non-local test databases.
- **`inRollback(db, fn)`:** the default isolation. The test runs in a transaction that's always rolled back.
- **`truncateAll(db)`:** the escape hatch for concurrency tests.
- **Factories**, starting with `insertUser`.

`seedUser` moves out of the seed script into `src/seed-user.ts`, so it can be tested, and `assertLocalDatabase` is shared by the seed and the harness.

Tests: seed idempotency, Telegram linking and relinking, the identity constraints (unique email, one user per chat, cascade delete), and isolation (a row written in one test isn't visible in the next).

Wiring:
- `TEST_DATABASE_URL` in `.env.example`.
- The root `test` script passes `--env-file=.env.local` (`bun test` doesn't load it in test mode).
- CI gets a Postgres 18.6 service container and `TEST_DATABASE_URL`.
- The pre-commit hook already runs `bun run check`, so it picks the tests up.
- `docs/testing.md` explains how to write a DB test.

Verify: all tests pass locally and in a simulated CI run (a clean Linux container plus a separate Postgres container). A deliberately broken assertion fails, and Postgres being down produces the clear message.
