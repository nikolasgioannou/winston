---
id: "3d5f3d"
title: Teach Winston to browse well
status: done
priority: none
labels:
  - m8
  - prompts
created_at: 2026-09-27T05:42:04.247Z
updated_at: 2026-10-02T16:53:19.065Z
blocked_by:
  - "1d60a8"
  - "732b45"
  - "91faf5"
  - "ff4636"
---

Browser use is a core strength of the product, so the background prompt (and a shorter version for the front of house) needs solid browsing guidance, best effort (docs/design.md §5 Browser, docs/research/browser-agents.md):
- **Strategy:** open your own window. `snapshot` first, and act by ref. `screenshot` + `view_image` to check visual state. `eval` or Python for extraction and bulk work. `click-xy` only when refs fail. `autopilot` for routine multi-click stretches.
- **Site skills:** before visiting a site, check notes for a site skill file (login quirks, flows, selectors). After a successful run, write or update it. Suggest a conventional location, for example `~/notes/sites/<domain>.md`. The structure is Winston's to decide.
- **Mandatory verification:** before reporting success on anything that committed something (booking, purchase, form submission, message), take a screenshot, check the page, and confirm the goal state.
- **Handoffs:** call `browser_handoff` when blocked by login, CAPTCHA, 2FA or a choice only the user can make. Say exactly what's needed. After resuming, re-snapshot. Logins persist in the shared profile, so handoffs should become rarer over time.
- **Etiquette:** respect domain lock conflicts (exit 6), close your window when done, and never submit payments or irreversible forms without the user's confirmation (confirm-first applies to the browser too, and the server can't police clicks, §5).
- **Front of house:** quick read-only peeks at a background agent's window are fine. Anything more gets delegated.

Keep the prompt static, and shorter than your instinct says. `--help` carries command details.

## As built

- `packages/prompts/src/background.md`: a "The browser" section under "Your computer" covering strategy (own window, snapshot then refs, screenshot + `view_image`, `eval`/Python for extraction, `autopilot` for routine stretches, `click-xy` last), site notes at `~/notes/sites/<domain>.md` (structure left to Winston), mandatory screenshot verification after committing actions, `browser_handoff` (say exactly what's needed, snapshot after), and manners (domain locks, close the window, confirm-first: prepare and stop before the final click).
- `packages/prompts/src/front-of-house.md`: a short "The browser" section: quick looks in its own window (its bash has 10 s), delegate anything longer, `browser_handoff` for its window, read-only peeks at a task's window, confirm-first. "You can't yet browse the web" is gone; that section is now "Staying honest".
- Command details stay in `--help`. Real-use review comes with 26dfa2 and 62e3d2.
