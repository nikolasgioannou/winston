---
id: "0fa82e"
title: Bootstrap the Bun workspace monorepo
status: done
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.037Z
updated_at: 2026-09-27T15:36:02.167Z
---

Nothing exists yet except `docs/` and `.moth/`. This ticket lays down the skeleton every other ticket builds into. See docs/design.md §7 (Language & repo) and §21 (Repo bootstrap).

Before writing config, research how Bun workspaces behave today: `workspaces` globs in the root `package.json`, how `workspace:*` dependencies resolve, how `bun install` hoists, and how `bun run --filter` works for running scripts across packages. Also check how mise pins Bun and Node per project (`mise.toml`, `mise install`), since the founder's rule is that runtimes come from mise and never from Homebrew or global installs. Pin current stable Bun and the latest Node LTS (24).

Create:
- `mise.toml` pinning `bun` and `node` exactly.
- `bunfig.toml` choosing the isolated linker.
- Root `package.json` (private, `"type": "module"`), with workspaces covering `apps/*` and `packages/*`, and a `bun.lock`.
- Only `packages/shared` (a bare `package.json` named `@winston/shared`), since the next tickets put real code there. Every other package is created by the ticket that first needs it.
- `.gitignore` with only what exists now (`node_modules`, and `.DS_Store`, which macOS creates in any folder). Later tickets add entries as they create things to ignore.
- A short `README.md`: what Winston is (one paragraph), how to install the toolchain (`mise install`, `bun install`), and pointers to `docs/`.

Done when a fresh clone can run `mise install && bun install` with no errors, and `bun run --filter '*' <script>` proves workspace packages are discovered (a throwaway script is fine; don't commit it).
