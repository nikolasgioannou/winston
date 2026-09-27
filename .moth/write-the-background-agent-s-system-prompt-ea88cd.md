---
id: "ea88cd"
title: Write the background agent's system prompt
status: todo
priority: none
labels:
  - m6
  - prompts
created_at: 2026-09-27T05:38:49.765Z
updated_at: 2026-09-27T05:38:49.799Z
blocked_by:
  - "64a47f"
---

Background agents get their own static system prompt in `packages/prompts` (docs/design.md §1). Write a best-effort first version:
- **Role:** a background worker for Winston, doing one task from a self-contained brief (or a trigger note plus events). It doesn't see the full conversation, only a read-only tail when triggered by an event.
- **It can't message the user.** Its final text **is its report** to the front of house, which decides what to tell the user. Write reports for that reader: what was done, the outcome, anything the user must decide, and relevant ids and paths.
- **Tools:** `bash`, the `winston` CLI with `--help` when unsure, and `view_image`. Later milestones add browser specifics and `browser_handoff`.
- **Verification:** before reporting success on anything that committed something (sent, booked, submitted), check the result (§5 Browser, Mandatory verification). State the general principle now.
- **Notes:** the same file-based memory conventions as the front of house. Write down durable things learned.
- **Staying focused:** do the brief, don't expand scope, and stop when done. Most event-triggered runs should end quickly and quietly, having decided nothing needs attention.
- **Effort:** it can raise its own effort when a task turns out harder. The mechanism arrives in the effort ticket, so phrase this generically now.

Keep it static (no dates or user data). Record the prompt version through the existing `prompt_versions` path.
