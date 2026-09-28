---
id: "103e94"
title: Stream the front of house's replies and replace no_reply with end_turn
status: done
priority: none
labels:
  - agents
  - m2
  - telegram
created_at: 2026-09-28T04:23:54.073Z
updated_at: 2026-09-28T04:37:09.570Z
blocked_by:
  - "cb9674"
  - "d4bb0d"
---

The front of house's replies become streamed: everything Winston writes is sent to the user as he writes it, in order, and `no_reply` becomes `end_turn`. Decided with the user on 2026-09-28 after an eval (docs/research/reply-design.md), reversing decision #68 and changing invariant 6 (docs/design.md Part 3), which the user agreed to.

Why: under "the final text is the reply", Winston often writes his real message in the same step as a tool call (for example beside `attach`), and it's dropped as narration. In the eval that happened in 18 of 64 trials, and some left the user with only "Done." or a misleading "Sent.". Streamed replies passed 63/64 against 58/64, with no narration leaked and no premature claims. It also settles the open "progress messages" question in §4.

What changes:
- **Delivery per step.** A step's text is sent before its tool calls run, so what the user sees follows what Winston wrote: text, then a file, then more text. Text after the last tool call is sent too. Each message goes through the existing Rich Message path (sanitize, line breaks, split, plain-text fallback) and is recorded in `outbound_messages`.
- **`end_turn` replaces `no_reply`.** It ends the turn; any text in the same step is sent first. Called without text, it's silence. A step with text and no tool calls also ends the turn. A step with neither text nor tool calls, and no message sent this turn, is still a glitch and gets the one "Please continue." nudge.
- **Steering.** Before a step's text is sent, check for new input. If some arrived while the step was written, that text isn't sent and the step's tool calls aren't run (their results say so, keeping the transcript valid). The new input is claimed with a one-line note, and the model decides again. Steps with only tool calls run as today. Messages already sent stay sent.
- **Prompt.** Rewrite the front-of-house "Replying" section and the reaction line as tested in the eval: everything you write is sent right away and in order; don't narrate your work (one short heads-up before long work is fine); text beside a tool call is sent before it runs, so don't claim success early; call `end_turn` when done.
- **Unchanged:** background agents never message the user; their final text is still their report (§5).

Update docs/design.md (§1 steering and stale drafts, §4 "Processing without responding", §5 tools, invariant 6, §16, the decision log with a new entry superseding #68) and the tickets that assume the old design (68fe0c, d4bb0d, f661c5, 1796c0, 62e3d2, 1fd02f, ea88cd where relevant). Add docs/research/reply-design.md with both evals: prior art, harness, prompts and numbers.

Tests: text then tool order in delivery, text after the last tool call is sent, `end_turn` with and without text, the empty-turn nudge, steering dropping a step's text and skipping its tools, several messages in one turn recorded in order.

## Outcome

- Each step's text is sent from `onLanguageModelCallEnd`, which the AI SDK awaits before running the step's tools; refusal text (finish reason `other`) is never sent, and Telegram errors are rethrown after the step. If new input is waiting, the step is dropped: nothing is sent and every tool (wrapped by `unlessDropped`) returns "Not run…", then the input is claimed with a note.
- `end_turn` replaced `no_reply`; a step with text and no tool calls, or an empty step after earlier messages, also ends the turn. An empty turn with nothing sent is still nudged once.
- Prompt "Replying" section rewritten as tested; docs/design.md §1, §4, §5, invariant 6 and decision #70 (superseding #68) updated; docs/research/reply-design.md added; tickets 68fe0c, 1796c0 and 62e3d2 updated.
- Verified live: a multi-step question answered in one clean message with no narration, "thanks" got silence, and "rename the photos…" followed by "actually, don't" got "Got it, leaving it as is." with nothing renamed (both arrived in one turn, so dropping a step mid-turn is covered by tests only).
