---
id: "b1f904"
title: Write AGENTS.md with the repo's working principles
status: done
priority: none
labels:
  - docs
  - m0
  - tooling
created_at: 2026-09-27T15:41:47.243Z
updated_at: 2026-09-27T16:11:33.634Z
blocked_by:
  - "0fa82e"
---

The way this repo gets built has settled into working rules. Put them in the repo, so every agent session (Claude Code, Codex, Cursor, …) works the same way. The repo is open source, so write for any contributor's agent: refer to "the user" and "a maintainer", never to a specific person.

Research first: what `AGENTS.md` is and which tools read it, and how Claude Code picks up project instructions. Finding: Claude Code (2.1.277+) reads `AGENTS.md` natively when a repo has no `CLAUDE.md`, and a `CLAUDE.md` would take precedence over it. So **only `AGENTS.md`**, with no `CLAUDE.md`.

**Only meta-level working rules**, nothing an agent could learn by looking around the codebase or docs: no stack, no directory tour, no commands, and nothing enforced by tooling (commit format is commitlint's job). The rules:
- **Tickets:**
  - Moth tickets in `.moth/`, ordered by `docs/plan.md`.
  - Re-check a ticket against the current docs and its dependencies before starting.
  - Raise conflicts between a ticket and the principles instead of following the ticket blindly.
  - Claim with `in-progress`, and move to `done` in the same commit. One ticket per commit.
- **Build for today, design for where we're going:** no speculative helpers, stubs, config or infrastructure. Think ahead on hard-to-change decisions (architecture, data shapes, interfaces), so later commits build on today's code rather than overwrite it. Deleting is fine when something no longer belongs.
- **Docs describe what's actually built:** update `docs/` and the ticket in the same commit.
- **Research a new tool before configuring it:** how it works today and how it fits with the existing stack and tools, using current docs rather than memory.
- **Ask rather than guess** on ambiguous or hard-to-reverse choices.
- **Invariants** (design.md Part 3) change only with a maintainer's agreement. `collab` tickets are done with the user.

Keep it short. Done when `AGENTS.md` exists and a fresh Claude Code session in the repo shows it loaded.
