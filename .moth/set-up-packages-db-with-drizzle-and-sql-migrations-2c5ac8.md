---
id: "2c5ac8"
title: Set up packages/db with Drizzle and SQL migrations
status: todo
priority: none
labels:
  - db
  - m1
created_at: 2026-09-27T05:28:45.480Z
updated_at: 2026-09-27T17:33:02.614Z
blocked_by:
  - "676648"
---

**Now also includes the typed config loader** (from canceled `29521a`): Zod-validated settings from the environment, starting with the database URL, plus `.env.local` / `.env.example`, since this is the first code that reads config. See `29521a` for the loader's requirements. Moved to the start of M1, right before the first tables.

`packages/db` owns the schema, the database client and migrations. It's the root of the end-to-end type chain (docs/design.md §7 and §12).

Research first, and write down the conclusions in the package README:
- Drizzle ORM's current release and API for Postgres.
- Driver choice under Bun: `postgres` (postgres.js) vs Bun's built-in SQL client via Drizzle's `bun-sql` adapter. Compare maturity, transaction support, `LISTEN/NOTIFY` (not needed yet), connection pooling behaviour, and anything that breaks `FOR UPDATE SKIP LOCKED` or raw SQL.
- `drizzle-kit`: `generate` producing plain SQL files, `migrate`, config file, and how migration journals work, so two branches adding migrations don't silently collide.
- `drizzle-zod`, so row types can become validators.

Deliver:
- `drizzle.config.ts`.
- A `db` client factory taking the database URL from the shared config.
- A `schema/` folder, empty apart from a `schema_meta`-style placeholder or nothing at all, whichever lets `generate` produce a valid first migration.
- Root scripts `db:generate` and `db:migrate`.

Migrations must be committed SQL files, applied in order, and safe to run repeatedly. Prove it by generating and applying an initial migration against the dev database, then running `db:migrate` again and seeing it do nothing.
