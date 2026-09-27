---
id: "021c52"
title: Run the checks on GitHub Actions
status: done
priority: none
labels:
  - infra
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.644Z
updated_at: 2026-09-27T17:41:01.019Z
blocked_by:
  - "51d785"
---

Hooks can be bypassed (`--no-verify`, or a machine without hooks installed), and once M4 lands every push to `main` deploys to production. CI re-runs the same checks as the backstop (docs/design.md §8b). Deploy steps get added to this workflow in M4.

**CI and the pre-commit hook run the same command.** A root `check` script runs `format:check`, `lint`, `typecheck` and `test` on the whole repo. The pre-commit hook runs it after auto-formatting staged files, and CI runs it too. A commit that passes the hook passes CI by construction. That matters because failing CI runs shouldn't end up in the history. (This replaces the hook's earlier staged-files-only lint.)

Research the GitHub Actions setup: installing the mise-pinned toolchain (`jdx/mise-action`, which reads `mise.toml` so CI and local can't drift), and a minimal, read-only workflow. The Postgres service container comes with the test-harness ticket (`fc638d`), together with the first database tests.

Create `.github/workflows/ci.yml`, triggered on pushes to `main`: checkout (without persisting credentials), `jdx/mise-action`, `bun install --frozen-lockfile`, `bun run check`.

**Verification:** no scratch branches and no deliberately failing runs. Before pushing, run the exact CI steps in a clean Linux container (a fresh clone, mise installing from `mise.toml`, a frozen-lockfile install, `bun run check`). Then the green run on the real commit is the proof.
