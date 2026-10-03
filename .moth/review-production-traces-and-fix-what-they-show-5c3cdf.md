---
id: "5c3cdf"
title: Review production traces and fix what they show
status: backlog
priority: none
labels:
  - agents
  - collab
  - spec
created_at: 2026-10-03T16:31:57.452Z
updated_at: 2026-10-03T16:31:57.452Z
---

**Collaborative.** The founder has used production Winston daily since go-live and seen him make mistakes and fail at things. Go through the production traces together and turn what they show into fixes.

- **The record:** what the database already has: model calls, `run_messages` (every step and tool call), inbound and outbound messages, background runs and their reports, trigger runs, handoffs, Jev decisions, the audit log and the cost ledger. `winston history` and `bun run prod costs` help navigate it.
- **Access:** production data is the founder's own conversations. Read it with them, or with their explicit go-ahead for this review (an earlier attempt to read it unprompted was rightly blocked).
- **What to look for:**
  - the mistakes and failures the founder remembers (collect a list from them first);
  - wrong or missing actions;
  - confirm-first slips;
  - promises without a trigger;
  - chattiness or silence at the wrong time;
  - weak briefs and wasted browser steps;
  - errors in the logs;
  - expensive runs.
- **Output:** small fixes (prompts, tool descriptions, bugs) done in this ticket; anything larger becomes its own ticket.
- Record what changed and why in docs/design.md, as the first prompt review did (62e3d2).
