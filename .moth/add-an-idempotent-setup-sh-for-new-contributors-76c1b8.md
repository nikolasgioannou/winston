---
id: "76c1b8"
title: Add an idempotent setup.sh for new contributors
status: done
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T16:59:38.822Z
updated_at: 2026-09-27T17:05:18.399Z
blocked_by:
  - "51d785"
---

A new contributor (or a new machine) should get from a fresh clone to a working repo with one command: `./scripts/setup.sh`. Running it again should be a quick health check, where every step is already done and reports green. Today there are only a few steps, but later tickets that add a setup requirement (Docker and Postgres, env files, migrations, seed data, tunnel credentials) extend this script instead of adding instructions to the README.

Shape:
- **Plain bash in `scripts/`.** It must run before mise or Bun are necessarily set up. A numbered list at the top of the script says what it does. The README only says to run it, so adding steps never means editing the README.
- **Check, then act, for every step,** with one clear line each (`✓ …` when already done, `→ …` while doing it). Safe to run any number of times.
- **Never installs global tools.** If something global is missing (mise today), say what's needed and how to get it, then stop. Project-local steps happen automatically.
- **Only today's steps:**
  1. mise is available.
  2. The repo's `mise.toml` is trusted.
  3. The pinned runtimes are installed.
  4. Dependencies are installed from the lockfile (without changing it).
  5. The git hooks are installed.

Research how mise behaves for a fresh clone (trusting config, running tools without shell activation via `mise exec`), so the script works even if mise isn't activated in the user's shell.

Point the README's setup section at the script, without listing its steps, and add a working rule to AGENTS.md: changes that add something contributors must set up also extend `scripts/setup.sh`.

Verify:
- Running it twice (the second run is all ✓).
- Deleting a git hook, then re-running, reinstalls it.
- Running with mise missing from `PATH` stops with a helpful message.
