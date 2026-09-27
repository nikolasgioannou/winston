---
id: "51d785"
title: Add lefthook pre-commit checks and commitlint
status: todo
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.270Z
updated_at: 2026-09-27T16:41:15.537Z
blocked_by:
  - "5b4554"
  - "991c7d"
---

After this ticket nothing can be committed unless formatting, linting, type checks and tests pass, and every commit message is a Conventional Commit with a subject line only (docs/design.md §8b). Every later ticket assumes this gate exists.

Research lefthook thoroughly before configuring it:
- Installing it as a **dev dependency via bun**, not globally (the founder's rule), and how hooks get installed on `bun install` (a `prepare`/`postinstall` script).
- `lefthook.yml` structure: `pre-commit` and `commit-msg`, `parallel`, `glob`, `{staged_files}`, `stage_fixed`.
- How to run Prettier and ESLint on **staged files only** while typecheck and tests run on the whole repo.

Then research commitlint: `@commitlint/config-conventional`, how to additionally forbid a body and footer (`body-empty`/`footer-empty`-style rules, or a small custom rule), allowed types, and how lefthook passes the message file to it.

Expected hook behaviour:
- **pre-commit:** Prettier (write + re-stage) and ESLint on staged files, then `typecheck`, then `test`.
- **commit-msg:** commitlint.

Include the Postgres-backed tests once the harness exists. For now, run whatever tests exist.

Verify by attempting commits locally that should fail: a lint error, a type error, a failing test, a message like `update stuff`, a valid subject plus a body. Each must be rejected. Then verify a clean commit goes through. Document how to run the hooks manually in the README.
