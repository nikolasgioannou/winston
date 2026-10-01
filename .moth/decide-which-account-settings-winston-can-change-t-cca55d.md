---
id: "cca55d"
title: Decide which account settings Winston can change through the CLI
status: done
priority: none
labels:
  - cli
  - collab
  - m5
created_at: 2026-09-30T22:21:08.359Z
updated_at: 2026-10-01T17:02:37.113Z
blocked_by:
  - "988f4d"
  - "fe870e"
---

Which account settings can Winston change through the CLI, and how does that fit with the site? Deferred by the founder after M3, since it needs a real discussion before building.

Today `winston me update --timezone` exists (M2), and it goes through the same `updateProfile` path as the site, so Winston hears of every change. But the site adopts the browser's time zone whenever it differs from the saved one, so a zone Winston sets (the user says "I'm in Tokyo this week") is overwritten the next time the site opens.

Decide with the founder:
- What Winston may change: time zone, name, others?
- How the browser sync and Winston's changes coexist. One option: sync only when the browser's zone changes since the last sync, not whenever it differs, so a change Winston makes sticks until the user really moves.
- How the CLI exposes it (`winston me update …`), and what Winston tells the user when he changes something.

Then build it and update design.md (§11 CLI, §20 time zone).

## Decision and as built

The founder asked for M4–M7 to run without pauses, inferring answers to collab questions. Decided:

- **Winston may change the time zone only.** Names identify the account and stay the user's to edit on the site; a nickname or preferred name goes in Winston's notes.
- **Browser sync follows the device only on a change:** `users.browser_timezone` holds the zone the browser last reported, and the site adopts the browser's zone only when that changes (`followBrowserTimezone` in `@winston/db/profile`). A zone Winston sets sticks while the laptop stays on home time, and carrying the device somewhere (or home again) still moves it. The migration backfills `browser_timezone` from `timezone`.
- **CLI:** unchanged, `winston me update --timezone <IANA>`. Winston says in his reply when he changes it (the prompt, f6613f).
- The toast no longer says "Change it on your profile", since the profile doesn't show the zone.

