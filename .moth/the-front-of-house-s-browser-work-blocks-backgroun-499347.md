---
id: "499347"
title: The front of house's browser work blocks background tasks
status: todo
priority: medium
labels:
  - browser
parent: "07ba81"
created_at: 2026-10-24T16:49:56.654Z
updated_at: 2026-10-24T16:50:33.295Z
---

The fixes from dfe034 (windows across runs) didn't cover the front of house's own windows.

**From the trace audit (07ba81):**

- **Locks outlive the turn:** the front keeps its site locks for minutes after its turn ends, and delegates without passing its window. Background tasks then sleep 45–70 s at a time on "… is in use by the front of house":
  - Oct 4: google.com, 4 minutes
  - Oct 5: ramp.com and fox.com
  - Oct 9: openai.com, where the task got around it by printing the front's tabs over raw CDP
- **Blank windows:** every refused `winston browser open` still leaves an `about:blank` window behind (7 on one Oct 5 task, 8 on Oct 4).
- **Long flows in the front:** the front does long browser flows itself (Ramp on Oct 5, five OpenAI posts on Oct 9, the BA check-in on Oct 2). It hits its 15-step cap partway and is forced to delegate.
- **Oct 4:** a window holding a filled-in, unsubmitted form vanished between turns, and everything had to be re-entered.
- **Oct 4:** `winston browser windows` called a window "yours" while `act` said the user had taken it over.

**What to build**

- The front's site locks are released when its turn ends.
- `winston browser open` checks the lock before creating a window.
- **Prompt:**
  - a flow of more than a page or two goes to `delegate` at the start, with the window if one is open;
  - the front closes its windows when done.
- A window handed to the user or holding unsubmitted work isn't closed by cleanup. If one is gone, the front is told rather than assuming it's there.
- `browser windows` shows who holds each window (the user or the run).

**Done when**

- [ ] A background task can open a site the front used in a turn that has ended, with no wait (test)
- [ ] A refused `open` leaves no new window (test)
- [ ] Replay of the Oct 9 OpenAI request: delegated at the start (3/3)
- [ ] `browser windows` marks windows the user has taken over (test)
- [ ] docs/design.md updated
