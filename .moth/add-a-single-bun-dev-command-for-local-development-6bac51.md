---
id: "6bac51"
title: Add a single `bun dev` command for local development
status: todo
priority: none
labels:
  - m1
  - tooling
created_at: 2026-09-27T05:30:54.358Z
updated_at: 2026-09-27T05:30:54.434Z
blocked_by:
  - "16c290"
  - "5cbe5b"
  - "676648"
  - "76c143"
---

Local development should be one command (docs/design.md §8a). `bun dev` should:
- Ensure Docker Postgres is up and migrated.
- Start `api` and `agents` with file watching and restart on change.
- Start the tunnel chosen in the tunnel ticket.
- Show all output in one terminal, prefixed per service.

`gateway` and `web` join this command in the tickets that create them. Leave an obvious place to add them.

Research the options for running and prefixing several watched processes under Bun: Bun's own `--watch` per service combined with a small orchestrator script, vs `concurrently` or similar. Pick the simplest thing that gives clean shutdown on Ctrl-C, with no orphaned processes or tunnels left behind.

Document it in `docs/local-dev.md`, including first-time setup: env file, seed, tunnel credentials, dev bot token. Done when `bun dev` from a fresh checkout (with `.env.local` filled in) brings everything up, and Ctrl-C brings everything down.
