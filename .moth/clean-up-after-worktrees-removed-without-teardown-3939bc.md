---
id: "3939bc"
title: Clean up after worktrees removed without teardown
status: done
priority: medium
labels:
  - tooling
created_at: 2026-10-04T01:45:53.077Z
updated_at: 2026-10-04T01:45:56.121Z
---

Archiving a desktop worktree session deletes the worktree's folder but not its databases or local VM, which only `bun run worktree remove` cleans up. Clean up after such worktrees automatically: `bun run worktree prune` finds the databases of worktrees whose folders no longer exist and removes them with their users' VMs, and `bun run worktree setup` runs it first, so leftovers never pile up. Only databases setup marked as a worktree's are ever touched.

## Outcome

Built in `scripts/worktree.ts`, documented in docs/local-dev.md (Worktrees), docs/design.md §8a and the `worktree` skill. Setup marks its database with the Postgres comment `winston worktree` on every run (so databases from before this are marked on their next setup). A worktree counts as gone when its folder isn't on disk, whatever git's list says. Prune also handles a marked database with no tables (a setup that stopped before migrating). It runs from any checkout; setup and remove still refuse the main one.

Checked: setup in a worktree pruned nothing and marked its database; prune removed a marked leftover (its `_test` database, a labeled VM container and volume) and a marked empty one, and left an unmarked database, the live worktree's databases and the main checkout's databases and VM alone; `bun run check`.

Rejected: Claude Code's `WorktreeRemove` hook, which replaces the app's own worktree removal and isn't documented to fire when a session is archived.
