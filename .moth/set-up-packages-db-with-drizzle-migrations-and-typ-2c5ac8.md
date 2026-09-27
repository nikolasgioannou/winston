---
id: "2c5ac8"
title: Set up packages/db with Drizzle, migrations and typed config
status: done
priority: none
labels:
  - db
  - m1
created_at: 2026-09-27T05:28:45.480Z
updated_at: 2026-09-27T17:58:35.815Z
blocked_by:
  - "676648"
---

`packages/db` owns the schema, the database client and migrations. It's the root of the end-to-end type chain (docs/design.md §7, §12). This ticket also brings the **typed config loader** (folded in from canceled `29521a`), because the database URL is the first thing any code reads from the environment. Moved to the start of M1, directly before the identity tables that first use it.

Research:
- Drizzle's current release vs the v1 release candidate. Outcome: **v1 RC** (`1.0.0-rc.4`, pinned), for its migration folder layout, relations v2 and built-in Zod validators.
- Driver choice under Bun. Outcome: **postgres.js**, for proven transactions, reserved connections and `LISTEN/NOTIFY`.
- drizzle-kit `generate` and `migrate` under Bun.
- Zod v4.
- How Bun loads `.env` files. Finding: only from the current directory, so package scripts load the root `.env.local` with `--env-file`.

Deliver:
- `@winston/shared/config`: `loadConfig(schema, env)`, which returns a frozen, typed object or throws one error listing every problem by variable name, never by value. Tests cover valid, missing and malformed input, and that values never appear in the error.
- `packages/db`: `createDb(url)` (Drizzle over postgres.js), `loadDbConfig()` (`DATABASE_URL`, a postgres URL), `drizzle.config.ts`, `tsconfig.json`, and `db:generate` / `db:migrate` scripts (package and root).
- `.env.example` (committed, listing every variable the code reads) and `.env.local` (gitignored). `scripts/setup.sh` creates `.env.local` from the example when missing.

No tables yet, so `db:generate` has nothing to generate. The first schema file and migration come with the identity tables ticket right after. Verify:
- `db:migrate` runs cleanly and is a no-op on re-run.
- Without `.env.local`, it fails with the loader's message naming `DATABASE_URL`.
