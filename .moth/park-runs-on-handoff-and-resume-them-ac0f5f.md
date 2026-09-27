---
id: "ac0f5f"
title: Park runs on handoff and resume them
status: todo
priority: none
labels:
  - agents
  - m6
created_at: 2026-09-27T05:38:50.008Z
updated_at: 2026-09-27T05:38:50.043Z
blocked_by:
  - "6abd88"
---

`browser_handoff(reason)` is a native tool **without an `execute` function**, so calling it ends the agent loop (docs/design.md §1 Implementation, §5). This ticket builds the generic mechanism. M8 adds the live-view link and screencast.

- **Background run:** calling `browser_handoff` persists the run as `parked`, with the reason, and produces a `task.needs_user` item (task id, reason, and a handoff link once M8 exists). The front of house tells the user what's needed. A parked run is **just data**, with no process waiting, and it never times out. The front of house may nudge once later (§1).
- **Front-of-house turn:** the same tool simply ends the turn. The user's reply arrives as the next message in the same conversation, so no parking is needed (§1).
- **Resume:** when `task resume` injects the note, the pending `browser_handoff` tool call needs a matching tool result before the loop continues (the AI SDK requires tool calls to be answered). Append a result like "user completed the handoff: <note>", then the note, and continue.
- **Routing "done":** update the front-of-house prompt. When the user says "done" or similar and tasks are parked, route to the right one via `winston task resume`, using context or a Telegram reply to the handoff message, and ask if it's ambiguous (§1).

Tests with the fake model: parking persists state and produces the item, resume answers the pending tool call and continues from the checkpoint, and a front-of-house handoff ends the turn without creating a parked run.
