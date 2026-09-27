---
id: "51d785"
title: Add lefthook pre-commit checks and commitlint
status: done
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.270Z
updated_at: 2026-09-27T16:50:53.044Z
blocked_by:
  - "5b4554"
  - "991c7d"
---

After this ticket nothing can be committed unless formatting, linting, type checks and tests pass, and every commit message is a Conventional Commit with a subject line only (docs/design.md §8b). Every later ticket assumes this gate exists.

Research lefthook before configuring it: installing it as a dev dependency via bun (Bun blocks dependencies' install scripts by default, so hooks are installed by a root `prepare: lefthook install` script instead), `lefthook.yml` jobs, `glob`, `{staged_files}`, `stage_fixed`, and how lefthook treats unstaged changes (it hides them while the hook runs). Research commitlint too: `@commitlint/config-conventional`, forbidding a body and footer (`body-empty` and `footer-empty` rules), TypeScript config support, and how lefthook passes the message file (`{1}`).

Hook behaviour:
- **pre-commit, in order:**
  - Prettier `--write --ignore-unknown` on staged files, re-staged (`--ignore-unknown` so files without a parser, like `bun.lock`, don't fail the hook).
  - ESLint on staged `.ts` files with `--max-warnings 0`. It reports only, with no auto-fix.
  - `typecheck` on the whole repo.
  - `test` on the whole repo: whatever tests exist. The Postgres-backed tests join when their harness lands.
- **commit-msg:** commitlint.

Verify with commits that must be rejected, each failing on the right step: a lint error, a type error, a failing test, a message like `update stuff`, and a valid subject plus a body. Then verify, in a throwaway clone, that a clean commit goes through, and that an unformatted file is committed formatted. Document running the hooks manually in the README.
