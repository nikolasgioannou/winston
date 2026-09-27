---
id: "676648"
title: Run Postgres locally with Docker Compose
status: todo
priority: none
labels:
  - db
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.331Z
updated_at: 2026-09-27T05:28:45.362Z
blocked_by:
  - "0fa82e"
---

Local development runs Postgres in Docker (docs/design.md §8a). Production will use RDS, so match its major version.

Add a `docker-compose.yml` at the repo root with a `postgres` service:
- The same major version we'll run on RDS.
- A named volume for data.
- A healthcheck.
- A port binding to localhost only.

Create two databases on first start: `winston` for development and `winston_test` for the test harness, so tests never touch dev data. An init script in `docker/postgres/` is fine.

Add root scripts `db:up` / `db:down` (and something to wipe the volume when needed), and document them in the README. Put the connection strings in `.env.example`, which is committed and lists every variable with a comment. The real `.env.local` is gitignored.

Quick research note: check which Postgres extensions we'll want later (full-text search is built in; `pgcrypto` may be handy) and that the chosen image supports them. Verify `psql` can connect to both databases after `bun run db:up`.
