---
id: "cb9674"
title: Run a minimal front-of-house turn that can reply
status: todo
priority: none
labels:
  - agents
  - m1
created_at: 2026-09-27T05:30:54.751Z
updated_at: 2026-09-27T05:30:54.842Z
blocked_by:
  - "36a9c9"
  - "5cbe5b"
  - "9f3814"
  - "db2a16"
  - "e47a50"
---

This is the milestone's heart: message the dev bot and Winston answers. It implements the `front_turn` job handler in `apps/agents` (docs/design.md §1, §4, §16).

A turn:
1. Creates a `runs` row (`kind: front`, `trigger_type: user`).
2. Loads the user's front-of-house message stream from `front_state.window_start_message_id`. Trimming comes in its own ticket. For now, load everything.
3. Renders the unconsumed inbound items into envelopes and appends them as a user message.
4. Runs the model loop on the `front` profile with one tool, `send_message(text)`.
5. Appends every step to `run_messages` via `onStepFinish`, and marks the consumed inbound items with the run id.

Key rule: the model's final text is **never** sent to the user. Only `send_message` reaches Telegram, and ending a turn without calling it is legitimate (§4, "Processing without responding"). For this ticket, `send_message` can send plain text through the Telegram Bot API and store an `outbound_messages` row. The formatting ticket upgrades delivery.

Build a **scripted fake model** for tests. It plays back predetermined tool calls and text, with no network. The steering, budget and background-agent tickets will reuse it heavily, so make it pleasant to write scenarios with.

Tests with the fake model:
- A reply is sent and recorded.
- A turn that ends silently sends nothing.
- Every step lands in `run_messages` in order.
- Inbound items are marked consumed exactly once.

Manual check: talk to @RunWinstonDevBot via `bun dev` and get sensible replies.
