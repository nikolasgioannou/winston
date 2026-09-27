---
id: "d4bb0d"
title: Steer running turns with new input and drop stale replies
status: todo
priority: none
labels:
  - agents
  - m1
created_at: 2026-09-27T05:30:54.993Z
updated_at: 2026-09-27T05:30:55.039Z
blocked_by:
  - "ed1e47"
  - "eeb50f"
---

When the user sends "wait, make it 8" while Winston is mid-turn, the running turn must take it into account instead of finishing a stale answer (docs/design.md §4, Steering, and §1 for the AI SDK hook mapping).

Two mechanisms:
1. **Injection at step boundaries.** In `prepareStep`, pull any unconsumed inbound items for this user, render them, append them to the messages, and mark them consumed by this run.
2. **Discarding stale drafts.** The reply is the final text, delivered after the loop ends (docs/design.md §4, decision #68). Just before delivery, check whether new inbound items arrived since the turn started or since the last injection. If so, don't send: discard the draft, append the new input, and continue the loop so the model writes a better reply. Once a reply is sent, it stays sent. Actions already taken aren't undone.

Edge cases to handle deliberately:
- Input arriving after the model's last step, when the turn is about to end. It should trigger a follow-up turn, not be lost (coordinate with serialization).
- A burst arriving during a long tool call.

Tests with the fake model:
- Injection happens at the next boundary.
- A stale draft is discarded and the rewritten reply is sent.
- A reply already sent before the input arrived isn't retracted.
- Late input after the final step produces a new turn.
