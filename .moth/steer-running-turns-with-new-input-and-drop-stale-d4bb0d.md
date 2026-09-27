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
2. **Dropping stale sends.** `send_message`'s `execute` first checks whether new inbound items arrived since the turn started or since the last injection. If so, it does *not* send, and returns a result telling the model "not sent: new input arrived". The next step then sees the injected input and can write a better reply. Once a message is sent, it stays sent. Actions already taken aren't undone.

Edge cases to handle deliberately:
- Input arriving after the model's last step, when the turn is about to end. It should trigger a follow-up turn, not be lost (coordinate with serialization).
- A burst arriving during a long tool call.

Tests with the fake model:
- Injection happens at the next boundary.
- A stale send is dropped and the rewritten one is sent.
- A reply already sent before the input arrived isn't retracted.
- Late input after the final step produces a new turn.
