---
id: "0fb4ab"
title: act can't see custom widgets that have no ARIA roles
status: backlog
priority: low
labels:
  - browser
parent: "07ba81"
created_at: 2026-10-24T18:50:25.945Z
updated_at: 2026-10-24T18:50:25.945Z
---

Found while working b60483. `act` and the page reader find controls by tag and ARIA role (`fast-page.ts` `readState`), and they walk open shadow roots. A custom widget built from plain elements, with no role (BA's `<ba-select>` dropdowns and its passenger checkbox, Oct 12), isn't offered at all. The agent then falls back to `eval` and `click-xy` from screenshots: BA's check-in took 77 steps and $1.63.

**What to build**

- Get a real fixture of such a widget first (BA's manage-booking pages, saved).
- Offer elements that act like controls without a role, for example a `cursor: pointer` element with a click handler, or a custom element whose shadow root holds a native control. Do it with care: a looser selector floods Jev with noise.

**Done when**

- [ ] A saved BA-style custom select and checkbox can be operated by `act` (Chrome fixture test)
- [ ] The hotel and search fixtures don't get noisier (same action counts within a few)
