---
id: "0fa82e"
title: Bootstrap the Bun workspace monorepo
status: todo
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.037Z
updated_at: 2026-09-27T05:28:45.053Z
---

Nothing exists yet except `docs/` and `.moth/`. This ticket lays down the skeleton every other ticket builds into. See docs/design.md §7 (Language & repo) and §21 (Repo bootstrap).

Before writing config, research how Bun workspaces behave today: `workspaces` globs in the root `package.json`, how `workspace:*` dependencies resolve, how `bun install` hoists, and how `bun run --filter` works for running scripts across packages. Also check how mise pins Bun and Node per project (`mise.toml`, `mise install`), since the founder's rule is that runtimes come from mise and never from Homebrew or global installs. Pin current stable Bun and Node 22.

Create:
- `mise.toml` pinning `bun` and `node` (Packer, Terraform and the AWS CLI get added later, by the tickets that introduce them).
- Root `package.json` (private, `"type": "module"`), with workspaces covering `apps/*`, `packages/*` and `infra`, and a `bun.lock`.
- Empty but valid packages for the layout in §21: `apps/{api,agents,gateway,web,cli,winstond}` and `packages/{db,shared,prompts,ui}`. Each gets a `package.json` named `@winston/<name>` and a trivial `src/index.ts`, just enough for the workspace to resolve. `infra/` and `image/` can wait for their own tickets.
- `.gitignore` covering `node_modules`, build output, `.env*` except `.env.example`, and OS/editor noise.
- A short `README.md`: what Winston is (one paragraph), how to install the toolchain (`mise install`, `bun install`), and pointers to `docs/`.

Done when a fresh clone can run `mise install && bun install` with no errors, and `bun run --filter '*' <something trivial>` proves every workspace package is discovered.
