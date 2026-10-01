---
id: "78c130"
title: Write production Dockerfiles for the four services
status: done
priority: none
labels:
  - infra
  - m4
  - tooling
created_at: 2026-09-27T05:36:32.510Z
updated_at: 2026-10-01T04:57:17.762Z
blocked_by:
  - "4e6f9b"
  - "5cbe5b"
  - "6b393b"
  - "76c143"
---

`api`, `agents`, `gateway` and `web` run as Bun containers on Fargate (docs/design.md §9).

Research current best practice for Bun images: the official `oven/bun` images, distroless and slim variants, multi-stage builds that install only production dependencies for one workspace in a monorepo, and `bun build` for a single bundled entrypoint vs running TypeScript directly. For `web`, look at the TanStack Start/Nitro `bun` preset output and how to serve it.

Requirements:
- Small images that start fast. Run as a non-root user.
- Build from the repo root with a proper `.dockerignore`, so each image only copies what its workspace needs.
- Health endpoints wired (the api health route, and equivalents for the others per the agents-worker notes).
- Graceful SIGTERM handling preserved. In particular, make sure the process is PID 1 or behind a minimal init, so signals reach Bun.

Add `bun run docker:build` to build all four locally, and check each boots with a local env against Docker Postgres. Note image sizes in the PR, or the commit if there's no PR.
