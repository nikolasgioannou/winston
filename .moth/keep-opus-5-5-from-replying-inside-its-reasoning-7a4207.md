---
id: "7a4207"
title: Keep Opus 5.5 from replying inside its reasoning
status: backlog
priority: medium
labels:
  - agents
created_at: 2026-10-03T21:20:56.325Z
updated_at: 2026-10-03T21:20:56.325Z
---

From ea2e27's replays (2026-10-03). On Opus 5.5 at `low` effort through OpenRouter, the front of house sometimes ends a turn with `end_turn` and no text: the reply it meant to send comes back as a reasoning part instead ("Found that your dentist appointment with Dr. Patel was rescheduled to Thursday, Oct 15 at 2:30 PM … Want me to update the calendar?"). The front sends only text parts (§4), so the user gets silence.

- **How often:** 12 of 65 held-out replays, both before and after ea2e27's prompt lines; every Opus failure on the held-out cases was this. Never seen on Sonnet 5, and not on the long production contexts.
- **Why it matters now:** `frontFallback` is Opus 5.5 at `low` (docs/design.md §6), so a turn that falls back can end silently.
- **Why it matters next:** Opus 5.5 at `low` got the production grounding failures right (15/15) where Sonnet 5 still misses the drive time and the set times (ea2e27). This blocks considering it for the front.

## Approach

1. Reproduce with `bun run eval:replay --model opus --only dentist-moved,site-down,holiday-hours`, and read the raw OpenRouter response: did Anthropic return the reply in a thinking block, or did OpenRouter's `reasoning_details` mapping put a text block there?
2. Fix the cause where it is: a provider or request setting, the effort level, or the prompt. Not a front that reads replies out of reasoning.
3. Re-run the replays on both models, record the result next to ea2e27's in docs/design.md §1, and decide the front's model with the founder (Opus costs about 1.7× at the front's token mix).
