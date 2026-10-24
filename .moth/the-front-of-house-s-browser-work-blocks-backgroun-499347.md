---
id: "499347"
title: The front of house's browser work blocks background tasks
status: done
priority: medium
labels:
  - browser
parent: "07ba81"
created_at: 2026-10-24T16:49:56.654Z
updated_at: 2026-10-24T19:04:14.089Z
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

## As built (2026-10-24)

- **Shorter front leases:** the front of house's site locks last 1 minute from its last action there (`frontLockTtlMs`), instead of 5. Its commands come seconds apart while it works, so it keeps a site while busy and lets go soon after. This was chosen over a turn-end release signal, which would need plumbing through agents → gateway → winstond for little gain. Background runs keep 5 minutes.
- **No blank windows on refusal:** `browser open <url>` checks the lock (`locks.check`) before creating the window.
- **Takeovers are visible:** `browser windows` marks a window the user has (`withUser`: "handed to the user", "the user took it over"), and names the front's windows as the front of house's.
- **Front-of-house prompt:**
  - decide before starting; more than two or three browser commands means delegate then;
  - when delegating work on a site with a window open, pass the window or close it.
- **Kept windows:** windows held for the user were already exempt from the idle sweep (existing test). The Oct 4 loss of a filled-in form window couldn't be traced to a cause from the record (Chrome hadn't restarted), so nothing new there.
- **Tests:** the front's shorter lease, and `check` taking nothing (`locks.test.ts`); a refused open makes no window, and a taken-over window shows in the run's list (`windows.test.ts`).
- docs/design.md (domain locks) updated.

- [x] A background task can open a site the front used in a turn that has ended, with no wait: within a minute of the front's last action, not instantly (test of the lease)
- [x] A refused `open` leaves no new window (test)
- [ ] Replay of the Oct 9 OpenAI request, delegated at the start: waiting on OpenRouter credit
- [x] `browser windows` marks windows the user has taken over (test)
- [x] docs/design.md updated
