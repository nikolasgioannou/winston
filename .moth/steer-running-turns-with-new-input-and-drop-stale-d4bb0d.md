---
id: "d4bb0d"
title: Steer running turns with new input and drop stale replies
status: done
priority: none
labels:
  - agents
  - m1
created_at: 2026-09-27T05:30:54.993Z
updated_at: 2026-09-27T22:18:07.648Z
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

## Outcome

Built as described in docs/design.md §1 ("Steering", "Dropping stale replies") and §4.
- **Own loop:** the front of house now runs its own step loop (one `generate` call per step) instead of `prepareStep` injection. Messages that `prepareStep` returns apply only to that step, so injected input would vanish from later steps. The loop also makes the draft check and the empty-reply nudge plain code.
- **Dropped drafts:** a dropped draft stays in the append-only transcript. The injected input is led by a one-line note so the model knows the user never saw it, and the prompt explains that.
- **Late input:** input arriving after delivery is handled by the serialization sweep (a follow-up turn). A mid-turn message in the racing test is now steered into the running turn.
- **Tests:** a fake-model `onRequest` hook makes input arrive mid-call. A mutation check confirmed that removing the draft check fails the dropped-draft test.
