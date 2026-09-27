---
id: "62e3d2"
title: Review and refine the prompts from real use (with the founder)
status: todo
priority: none
labels:
  - collab
  - m9
  - prompts
created_at: 2026-09-27T05:42:36.330Z
updated_at: 2026-09-27T05:42:36.404Z
blocked_by:
  - "26dfa2"
  - "35c1ed"
  - "fa537d"
---

Every prompt so far was a best-effort draft written in the ticket that needed it. Refinement was always meant to come from real use (docs/design.md §1, Prompts live in the repo). By now there's a meaningful record in the database: model calls, run messages, silent turns, handoffs, event runs, and the founder's reactions.

With the founder:
- Pull examples from the database log of where Winston was too chatty, too quiet, got confirm-first wrong, wrote weak briefs, forgot to check notes, set up poor triggers, or wasted steps in the browser. Use the cost report too, to find expensive patterns.
- Rewrite the front-of-house, background and compaction prompts with those lessons. Keep them static and lean, and move command detail into `--help` wherever the prompt is carrying CLI specifics.
- Check the tool descriptions (`send_message`, `delegate`, `bash`, `view_image`, `browser_handoff`) as carefully as the prompts. They're prompts too.

Each prompt change produces a new `prompt_versions` hash automatically, so before-and-after behaviour stays traceable in the log. Done when the founder is happy with how Winston behaves day to day.
