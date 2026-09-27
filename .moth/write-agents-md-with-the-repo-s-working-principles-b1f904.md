---
id: "b1f904"
title: Write AGENTS.md with the repo's working principles
status: todo
priority: none
labels:
  - docs
  - m0
  - tooling
created_at: 2026-09-27T15:41:47.243Z
updated_at: 2026-09-27T15:46:04.255Z
blocked_by:
  - "0fa82e"
---

The way this repo gets built has settled into working rules the founder cares about. Right now they live only in conversation. Put them in the repo, so every agent session (Claude Code, Codex, Cursor, …) works the same way.

Research the conventions first: what `AGENTS.md` is and which tools read it, and how Claude Code loads `CLAUDE.md`, including `@path` imports. `AGENTS.md` is the single source. `CLAUDE.md` is a one-line file importing it (`@AGENTS.md`), not a symlink.

**Only meta-level working rules.** Nothing an agent could learn by looking around the codebase: no tech stack, no directory tour, no commands, no restating the docs. If it's discoverable from `package.json`, `mise.toml` or `docs/`, it doesn't belong here. The rules:
- **Work comes from tickets.** Moth tickets in `.moth/`, in the order given by `docs/plan.md`. Before starting, re-check the ticket against the current docs and the tickets it depends on, and adjust it first if reality has moved. Claim it with `in-progress`, and move it to `done` in the same commit as the work. One ticket per commit.
- **Don't be forward-looking.** Add only what the current ticket needs: no speculative stubs, config, packages or ignore entries "for later".
- **Commits are additive.** Extend earlier work. Never refactor, rewrite or mass-delete it between commits. If a ticket seems to require reworking earlier code, raise it with the founder instead.
- **Docs describe what's actually built.** When a decision or implementation changes, update `docs/` and the ticket in the same commit.
- **Research a new tool before configuring it:** its current config and how it fits with what's already here.
- **The invariants in docs/design.md Part 3 change only with the founder.** Collaborative tickets (label `collab`) are done with the founder, not alone.
- **Commits:** Conventional Commits, subject line only (no body or footer). Push after every commit.
- **Ask before any global change,** such as installing tools or runtimes outside the repo.

Keep it short. Done when both files exist, and a fresh Claude Code session in the repo picks up the rules via `CLAUDE.md`.
