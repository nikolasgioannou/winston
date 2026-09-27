---
id: "cb9674"
title: Run a minimal front-of-house turn that can reply
status: done
priority: none
labels:
  - agents
  - m1
created_at: 2026-09-27T05:30:54.751Z
updated_at: 2026-09-27T21:42:56.621Z
blocked_by:
  - "36a9c9"
  - "5cbe5b"
  - "9f3814"
  - "db2a16"
  - "e47a50"
---

This is the milestone's heart: message the dev bot and Winston answers. It implements the `front_turn` job handler in `apps/agents` (docs/design.md §1, §4, §16).

A turn:
1. Creates a `runs` row (the `kind`/`trigger_type` columns arrive with background agents in M6, per docs/design.md §12).
2. Loads the user's front-of-house message stream from `front_state.window_start_message_id`. Trimming comes in its own ticket. For now, load everything.
3. Renders the unconsumed inbound items into envelopes and appends them as a user message.
4. Runs the model loop on the `front` profile with one tool, `no_reply`.
5. Appends every step to `run_messages` via `onStepEnd`, and marks the consumed inbound items with the run id.

Key rule (docs/design.md §4, "Processing without responding", decision #68): the model's **final text is the reply**, sent through the Telegram Bot API and stored as an `outbound_messages` row. Calling `no_reply` ends the turn in silence. An empty ending is nudged once ("Please continue."), never taken as silence. Text beside tool calls is never sent. The formatting ticket upgrades delivery.

Build a **scripted fake model** for tests. It plays back predetermined tool calls and text, with no network. The steering, budget and background-agent tickets will reuse it heavily, so make it pleasant to write scenarios with.

Tests with the fake model:
- The final text is sent and recorded.
- `no_reply` ends the turn after one call and sends nothing, even with text beside it.
- An empty reply is nudged once.
- Every step lands in `run_messages` in order.
- Inbound items are marked consumed exactly once.

Manual check: talk to @RunWinstonDevBot via `bun dev` and get sensible replies.

## Outcome

Built as described in docs/design.md §16 ("Implementation"). The handler is registered in `apps/agents/src/main.ts`. The agents service now needs `OPENROUTER_API_KEY` and `TELEGRAM_BOT_TOKEN`.
- **Consuming input:** inbound items are claimed, rendered and marked consumed in one transaction at the start of the turn, so "consumed exactly once" holds even if the model fails. Recovering an unanswered message after a failure is left to the failures ticket.
- **Reply-to:** targets are resolved here, as the envelope ticket intended.
- **Replies (changed during this ticket, decided with the user):** the original design delivered only `send_message` calls and discarded the final text. Talking to the bot showed Sonnet 5 often wrote the reply as plain text, so it was lost ("my sisters name is Bella" got no response). Prompt rewording didn't fix it: about half of replies were still lost with history. Research found Letta dropped the same design for the same reason, and an eval compared the options. So the final text is now the reply, and `no_reply` is explicit silence (24/24). This updated invariant 6, §1, §4, §5, §12, §16 and decision #68 (superseding #16), and the steering, typing, attachments and prompt-review tickets.
- **Fake model:** the scripted fake OpenRouter from the model-log ticket, plus `toolCallReply()` / `textReply()` helpers. Scenarios run through the real gateway, recorder and database.
- **Manual check:** a real turn through `bun dev` answered the four queued test messages in one batch (2 model calls, about $0.007, served by Anthropic, cache read on step 2).
- **Design doc fix:** `effort` is no longer listed among the future `runs` columns (decision #67 fixed effort per profile).
