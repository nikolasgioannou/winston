---
id: "ebd998"
title: Trim the front-of-house window and place cache breakpoints
status: done
priority: none
labels:
  - agents
  - m1
created_at: 2026-09-27T05:30:55.054Z
updated_at: 2026-09-27T22:23:49.312Z
blocked_by:
  - "cb9674"
---

The front of house doesn't summarize. It keeps a rolling window of recent conversation (docs/design.md §2 Rolling window, §16). The budget is about 150k tokens. When exceeded, the window start advances until it's about 100k. It trims **in chunks** rather than one message per turn, so the cached prefix stays stable between trims.

Implement:
- Token estimation for the window. Research whether OpenRouter/Anthropic token counting is available and cheap, or whether a local estimate is good enough. The trim threshold just needs to be roughly right. Consistency matters more than precision.
- Trimming that only cuts at turn boundaries, never between a tool call and its result. It updates `front_state.window_start_message_id`. Nothing is ever deleted from the database.
- Cache breakpoint placement: one after the static system prompt and tools, one at the end of the previous turn. Verify with real calls (the model smoke script, or logging) that consecutive turns show large cached-token counts, and that a trim causes one cache miss, then caching resumes.
- Make the thresholds configurable.

Tests: trimming stays at turn boundaries, never splits tool call/result pairs, happens in chunks (not on every turn), and a window under budget is untouched.

## Outcome

Built as described in docs/design.md §2 ("Rolling window", Implementation) and §16.
- **Token measure:** the latest model call's real usage. Anthropic's `count_tokens` isn't reachable through OpenRouter, and a local estimate would be less exact. Per-turn shares are scaled estimates, which is enough to choose the cut.
- **Breakpoint moved:** the rolling breakpoint moved from "end of the previous turn" to "last message of each request". Real `model_calls` data showed only the system prompt was ever read back, and a request probe showed why: the provider can't mark assistant messages.
- **Verified with real calls:** reads grew every turn (all but the newest ~400 tokens), and a forced trim cost exactly one miss.
- **Config:** thresholds are `FRONT_WINDOW_MAX_TOKENS` / `FRONT_WINDOW_TARGET_TOKENS` in agents config, validated so the target is below the max.
