---
id: "605675"
title: The site leaks a Postgres pool on every dev reload
status: done
priority: high
labels:
  - tooling
created_at: 2026-10-07T15:13:02.576Z
updated_at: 2026-10-07T15:13:09.838Z
---

A long `bun dev` session ends in Postgres "too many clients" (~96 connections from the web app alone). `apps/web/src/server/db.server.ts` kept its pool in a module-level `let db`. Vite re-runs server modules on every SSR reload in the same process, so each reload opened a new postgres.js pool (up to 10 connections) while the old one kept its connections: postgres.js has no idle timeout by default, so they were never released.

**What to build**

- Keep the site's pool on `globalThis`, so reloads reuse it.
- Check whether agents, api and gateway leak the same way under `bun --watch`.

**Done when**

- [x] Editing server files under a running `bun dev` doesn't add connections from the web process
- [x] The other services' behaviour under their watchers is checked and, if needed, fixed


## As built

`database()` keeps the pool on `globalThis.winstonWebDb` (declared in `db.server.ts`). Production is unchanged: it was one pool per process before too.

Checked in a worktree with `bun dev`, counting the Vite process's own sockets to :5432 with `lsof` (every service shows up in `pg_stat_activity` as `postgres.js`), with a request carrying a session cookie after each edit so the site queries:

- **Before:** each edit of `session.server.ts` or `config.server.ts` added one connection that never closed (1 → 7 over six edits, and 1 → 6 over five on a fresh stack). Concurrent requests after a reload open more of each pool's 10, which is how it reached ~96.
- **After:** 1 connection throughout seven edits, including edits to `db.server.ts` itself.
- **agents, api, gateway:** not affected. `bun --watch` restarts the whole program (`SIGTERM`, then a fresh start), so the old pool goes with it; their counts (8, 1, 1) held steady over three edits each.
