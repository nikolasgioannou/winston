---
id: "d8b401"
title: Send Winston's working text as messages, steered by the prompt
status: done
priority: none
labels:
  - agents
  - telegram
created_at: 2026-10-04T01:35:44.026Z
updated_at: 2026-10-04T01:37:53.024Z
---

22672b stopped showing Winston's interim text, but the founder wants progress messages when they're useful (a long task, a wait, a change of plan). feebd3 went past the prompt because "Don't narrate your work" didn't stop narration in production; that line never said every word becomes a permanent message, or when a progress note is worth sending.

## Change

- **Every step's text is a message again** (decision #70 as first built): text beside any tool call is sent as its model call ends, before the tool runs. No held text, no last-held-text fallback.
- **Prompt "Replying" teaches by cause:** every word you write is a permanent message, so write one only when the user would want it: the answer, a heads-up before a long task, a blocker, a change of plan. Never narrate steps; group results into one message rather than one per item; and since text beside a tool call is sent before it runs, never say something is done until you've seen it succeed.
- No new eval (the founder's call); production will show whether it holds.

Docs: §4 (Processing without responding, the prompt bullet), decision #77 superseded by a new one, §16 delivery.

Tests: text beside a working tool is a message sent before the tool runs; a dropped step sends nothing.
