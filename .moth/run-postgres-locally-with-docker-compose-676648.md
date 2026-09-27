---
id: "676648"
title: Run Postgres locally with Docker Compose
status: done
priority: none
labels:
  - db
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.331Z
updated_at: 2026-09-27T17:24:36.409Z
blocked_by:
  - "0fa82e"
---

Local development runs Postgres in Docker (docs/design.md §8a). Production uses RDS, so match its major version: PostgreSQL 18 (RDS's latest minor is 18.6, as of August 2026).

A Docker-compatible runtime is a **machine-level prerequisite**, not a repo dependency. The founder's machine runs Colima, installed through the global mise config in dotfiles. `scripts/setup.sh` checks that a Docker engine is reachable, starts Colima if it's installed but stopped, and otherwise stops with a helpful message. It never installs a runtime.

Add a `docker-compose.yml` at the repo root with a `postgres` service:
- `postgres:18.6`.
- A named volume at `/var/lib/postgresql`. PostgreSQL 18 images moved their data directory, and mounting the old `/var/lib/postgresql/data` path is a known gotcha.
- A `pg_isready` healthcheck.
- A port binding to localhost only.
- Local-only credentials.

Add root scripts `db:up` (start and wait until healthy) and `db:down`, and extend `setup.sh` with the Docker check and starting Postgres.

Deliberately left to the tickets that first need them:
- The `winston_test` database (the test-harness ticket).
- `.env.example` and connection-string config (the config and Drizzle tickets).
- Postgres extensions.

Verify:
- `psql` connects and reports 18.6.
- Data survives `db:down` and `db:up`.
- `setup.sh` handles each case correctly: everything running, Postgres stopped, Colima stopped, and no Docker at all.
