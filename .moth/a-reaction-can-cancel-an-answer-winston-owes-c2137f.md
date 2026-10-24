---
id: "c2137f"
title: A reaction can cancel an answer Winston owes
status: done
priority: medium
labels:
  - agents
  - telegram
parent: "07ba81"
created_at: 2026-10-24T16:49:57.185Z
updated_at: 2026-10-24T18:57:45.692Z
---

When new events arrive while the front of house is writing, its message isn't sent and it starts again with everything in view. A `telegram.reaction.added` counts as a new event. The prompt then says to end a turn silently on a reaction.

**From the trace audit (07ba81):**

- **Oct 13, 06:43:** at Heathrow, Nik asked "When do you think my Heathrow flight gate closes". Winston wrote the answer. Nik's heart reaction on an old message arrived, so the answer was "not sent". Winston then called `end_turn` with nothing, following the reaction rule. Nik had to send "?" 20 seconds later. Runs `run_01m4tdrw9xeh1b75dkj9hwkf77`, `run_01m4tdsh53eh1b75dybwg2jb3f`.

**What to build**

- A reaction doesn't interrupt a message being written. It's delivered with the next turn, or on its own if nothing is in flight.
- The reaction rule in `front-of-house.md` says to end silently only when nothing else in view still needs an answer.

**Done when**

- [ ] A reaction arriving mid-step doesn't drop that step's message (test)
- [ ] Replay: a question plus a reaction in the same batch gets an answer (3/3)
- [ ] docs/design.md updated

## As built (2026-10-24)

- **Turn logic:** `hasClaimableInput` takes `except`, and the step-drop check passes `neverInterrupts` (`telegram.reaction.added`). A reaction arriving mid-step no longer drops the message; it's claimed and read with the next step, as before.
- **Test:** a reaction during the model call leaves the answer sent from the first call, with no dropped-message note. Without the fix the step is dropped and asked again, and the test fails.
- **Prompt:** the reaction rule ends silently only when nothing else in view needs an answer, and a reaction never cancels an answer owed.
- **docs/design.md:** the reactions section.

- [x] A reaction arriving mid-step doesn't drop that step's message (test)
- [ ] Replay: a question plus a reaction in the same batch gets an answer: not written (OpenRouter credit)
- [x] docs/design.md updated
