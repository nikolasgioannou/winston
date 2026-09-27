---
id: "021c52"
title: Run the checks on GitHub Actions
status: todo
priority: none
labels:
  - infra
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.644Z
updated_at: 2026-09-27T17:33:39.579Z
blocked_by:
  - "51d785"
---

**Scope note:** CI now comes before any database code. It runs the checks that exist (format, lint, typecheck, tests). The Postgres service container is added by the test-harness ticket (`fc638d`) together with the first database tests.

Hooks can be bypassed (`--no-verify`, or a machine without hooks installed), and once M4 lands every push to `main` deploys to production. CI re-runs the same checks as the backstop (docs/design.md §8b). Deploy steps get added to this workflow in M4.

Research GitHub Actions setup for this stack:
- Installing the mise-pinned toolchain in CI (the official mise action vs `oven-sh/setup-bun`). Prefer whatever keeps the versions sourced from `mise.toml`, so CI and local can't drift.
- Caching Bun's install cache.
- A Postgres **service container** on the same major version as local, with the test database created.

Create `.github/workflows/ci.yml`, triggered on pushes to `main`. It should run: `format:check`, `lint`, `typecheck`, and `test` including the DB tests, so it covers the same set as pre-commit. Keep it one job with clear step names, so a failure is obvious at a glance.

Verify by pushing and watching the run go green. Also check that a deliberately failing check turns it red (in a scratch branch, deleted afterwards).
