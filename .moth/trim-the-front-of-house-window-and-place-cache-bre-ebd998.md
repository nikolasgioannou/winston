---
id: "ebd998"
title: Trim the front-of-house window and place cache breakpoints
status: todo
priority: none
labels:
  - agents
  - m1
created_at: 2026-09-27T05:30:55.054Z
updated_at: 2026-09-27T05:30:55.086Z
blocked_by:
  - "cb9674"
---

The front of house doesn't summarize. It keeps a rolling window of recent conversation (docs/design.md §2 Rolling window, §16). The budget is about 150k tokens. When exceeded, the window start advances until it's about 100k. It trims **in chunks** rather than one message per turn, so the cached prefix stays stable between trims.

Implement:
- Token estimation for the window. Research whether OpenRouter/Anthropic token counting is available and cheap, or whether a local estimate is good enough. The trim threshold just needs to be roughly right. Consistency matters more than precision.
- Trimming that only cuts at turn boundaries, never between a tool call and its result. It updates `front_state.window_start_seq`. Nothing is ever deleted from the database.
- Cache breakpoint placement: one after the static system prompt and tools, one at the end of the previous turn. Verify with real calls (the model smoke script, or logging) that consecutive turns show large cached-token counts, and that a trim causes one cache miss, then caching resumes.
- Make the thresholds configurable.

Tests: trimming stays at turn boundaries, never splits tool call/result pairs, happens in chunks (not on every turn), and a window under budget is untouched.
