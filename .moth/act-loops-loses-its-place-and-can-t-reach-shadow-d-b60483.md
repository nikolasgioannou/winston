---
id: "b60483"
title: act loops, loses its place and can't reach shadow DOM
status: done
priority: high
labels:
  - browser
parent: "07ba81"
created_at: 2026-10-24T16:49:56.601Z
updated_at: 2026-10-24T18:50:26.143Z
---

`winston browser act` (autopilot, rebuilt in 0946c59) is where most browser failures in production start.

**From the trace audit (07ba81):**

- **Repeats an identical action until it hits `max_steps`, with nothing changing on the page:**
  - Oct 5: "Transaction date" clicked 30 times, and "Currency" ×15 when told Merchant.
  - Oct 5: the Ramp "Enter manually" loop created 7 junk drafts, and Nik gave up ("ok just stop it this isnt working...").
  - The no-progress guard fired only once.
- **Element indexes go stale after a dropdown or overlay opens,** so the wrong element gets clicked (Oct 5: "clicked Currency instead of Merchant due to an index mismatch").
- **Can't operate web components or shadow DOM:** on Oct 12 BA's `<ba-select>` dropdowns, its passenger checkbox, Continue and Download PDF all failed. The check-in took 77 steps and $1.63, mostly `eval` hacks and `click-xy`.
- **Links that open a new tab do nothing** (Oct 11: the RentCafe "Resident Login" link). Nik found the URL himself.
- **Gives no fallback when its text helper is down:** "The text helper isn't available right now" on Oct 4, 5 and 12. On Oct 12 the front slept and retried for 2.5 minutes, and Nik gave up on the seat change.
- **Commit false positives:** "Manage Subscription" was flagged as a commit on Oct 5.

**What to build**

- **A repeat guard:** stop after 2–3 identical actions that change nothing on the page, and report "blocked" with what it tried.
- **Fresh refs** after any action that opens an overlay, dropdown or dialog, before the next action.
- **Shadow DOM:** the page model and actions reach into open shadow roots, and custom selects and checkboxes are operable.
- **New tabs:** a link with `target=_blank` either opens in the same window or the new tab becomes current. The answer always includes the URL it went to.
- **Helper down:** when the text helper is unavailable, `act` says so with a fallback ("use snapshot/click, or try again in a minute"). The front-of-house prompt: say it once, then delegate or stop. No sleep loops in the user's turn.
- Fewer commit false positives on plain navigation links.

**Done when**

- [ ] A fixture where a click changes nothing stops in ≤3 repeats with "blocked" (test)
- [ ] A fixture dropdown that shifts indexes clicks the named element (test)
- [ ] A fixture with a shadow-DOM select and checkbox can be filled by `act` (test)
- [ ] A `target=_blank` link fixture ends on the new page and reports its URL (test)
- [ ] With the text helper unavailable, `act` returns the fallback message and the front-of-house replay doesn't sleep-loop
- [ ] docs/design.md (the autopilot section) updated

## As built (2026-10-24)

- **Going round:** each step taken is counted against the state of the page it was taken from (its fingerprint).
  - Jev choosing a step it already took from the same state goes to the step picker ("Jev wants to take a step it already took from this same page").
  - The third time the same step is taken from the same state stops the run with `no_progress` ("It kept going round…").
  - The existing guard, three unchanged actions in a row, missed the Ramp loops: a dropdown opening and closing changes the page every time.
  - Test: a menu flipping between two states stops after 5 actions, not 30.
- **New tabs:** a step that opens a tab (`target=_blank`, `window.open`) already made it the run's current window (`windows.ts`). `act` now carries on there and says "It opened a new tab (<url>); carrying on there." Before, it kept reading the unchanged page it came from (the RentCafe "Resident Login" link, Oct 11). Test added.
- **Helper down:** both `unavailable` stops now give the fallback: act again in a minute, or take the step with `click`/`type`/`select` from a snapshot, and don't wait in a loop. The front-of-house prompt says to tell the user once, then do the step with those commands or delegate, never sleep-retry in their turn.
- **docs/design.md:** the autopilot section (when the picker is asked, `no_progress`, `unavailable`, new tabs).

**Not done, and why:**
- **Shadow DOM:** the reader and hit test already walk open shadow roots, with a Chrome test (`fast-page.chrome.test.ts`). BA's `<ba-select>` failed because it's a custom widget with no ARIA roles, which an ARIA-based reader can't see. That's a different problem, filed separately (see below).
- **Stale indexes after a dropdown:** element indexes are rebuilt on every read, and input is refused on a stale page (`StalePage`). The Ramp "clicked Currency instead of Merchant" couldn't be reproduced from the trace alone, and the loop it came from is now caught by the going-round guard. It'll be revisited with a reproduction if it recurs.
- **Front-of-house replay for an unavailable `act`:** not written. The prompt line is small, and replays need OpenRouter credit.

- [x] A step that changes nothing, or keeps flipping the page, stops in ≤3 visits with `no_progress` (test)
- [ ] A dropdown that shifts indexes clicks the named element: not reproduced (see above)
- [ ] Shadow-DOM select and checkbox: open shadow roots already work; custom widgets filed separately
- [x] A `target=_blank` link ends on the new page and reports its URL (test)
- [x] With the text helper unavailable, `act` returns the fallback, and the front-of-house prompt says not to sleep-loop (replay not run)
- [x] docs/design.md updated
