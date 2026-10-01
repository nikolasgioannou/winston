---
id: "438b86"
title: Let the front of house delegate work
status: done
priority: none
labels:
  - agents
  - m6
created_at: 2026-09-27T05:38:49.816Z
updated_at: 2026-10-01T17:41:48.056Z
blocked_by:
  - "64a47f"
  - "ea88cd"
---

`delegate(brief, effort)` is one of the front of house's two exclusive native tools (docs/design.md §1, §5). It starts a background run and returns immediately, so the front of house can acknowledge the user ("On it…") and keep chatting.

Build:
- The tool creates a `task_` run with `trigger_type: delegate`, `parent_run_id` set to the current front-of-house run, the brief as the run's first user message, and effort from the argument (`low`/`medium`/`high`, defaulting to high for user delegations, §6). It enqueues the first step and returns the task id.
- **Briefs must be self-contained:** the background agent sees nothing else from the chat. The tool description should say so firmly, and suggest what a good brief contains: goal, relevant context and preferences from notes, constraints, and what to report back.
- Update the front-of-house prompt's delegation section: the one judgment call is **expected duration**. Quick things it does itself, longer things it delegates (§1, Same capabilities). Acknowledge delegated work briefly.

Tests with the fake model: `delegate` creates exactly one queued run with the right fields and returns immediately, and the front-of-house turn completes without waiting for the task.

## As built

- `apps/agents/src/tools/delegate.ts`, placed before `end_turn` in the front's tools. `runs` gained `trigger_type` (enum, `delegate` for now) and `parent_run_id`.
- Prompt: "Working in the background" in `front-of-house.md`. Briefs must quote approvals word for word, matching the background prompt's rule that a brief asking to send isn't approval by itself (ea88cd).
- Delegation judgment is checked by eval together with reporting results (1fd02f), since the two only make sense end to end.

