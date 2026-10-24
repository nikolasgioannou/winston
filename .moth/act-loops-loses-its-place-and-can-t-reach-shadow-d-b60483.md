---
id: "b60483"
title: act loops, loses its place and can't reach shadow DOM
status: todo
priority: high
labels:
  - browser
parent: "07ba81"
created_at: 2026-10-24T16:49:56.601Z
updated_at: 2026-10-24T16:50:33.192Z
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
