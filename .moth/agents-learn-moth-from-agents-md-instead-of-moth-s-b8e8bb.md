---
id: "b8e8bb"
title: Agents learn moth from AGENTS.md instead of moth's own skill
status: done
priority: low
labels:
  - tooling
created_at: 2026-10-04T01:30:56.632Z
updated_at: 2026-10-04T01:30:59.066Z
---

Moth 0.6.0 ships the Moth Method, a skill that teaches agents how to write, find, claim and close tickets, built from the installed moth so it matches its version. AGENTS.md carried a hand-written subset of the same rules.

**What to build**

- Install the skill with `moth skill install --agent claude`
- Cut AGENTS.md's Tickets section to the rules specific to this repo
- New milestones and features are parent tickets; the `m0`…`m9` labeled tickets stay as they are
- Note next to Moth's pin that the skill is re-installed when the version changes

**Done when**

- [x] `.claude/skills/moth-method/SKILL.md` is committed at moth 0.6.0
- [x] AGENTS.md and docs/design.md §8c describe the split and the grouping rule
