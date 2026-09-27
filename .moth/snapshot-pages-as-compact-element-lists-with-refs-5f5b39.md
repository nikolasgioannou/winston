---
id: "5f5b39"
title: Snapshot pages as compact element lists with refs
status: todo
priority: none
labels:
  - browser
  - cli
  - m8
created_at: 2026-09-27T05:42:03.691Z
updated_at: 2026-09-27T05:42:03.728Z
blocked_by:
  - "6b73c4"
---

`browser snapshot` is the main way agents see a page: a compact list of interactive and meaningful elements with short refs (`e1`, `e2`, …). It's about 200–400 tokens for a typical page, versus thousands for a raw DOM dump (docs/design.md §5 Browser, docs/research/browser-agents.md).

Research how the best implementations do it: Vercel's agent-browser `snapshot -i`, Playwright's ARIA snapshots, and Browser Use's DOM serialization. Topics: which accessibility-tree nodes to keep, how to name elements (role plus accessible name plus state), handling iframes and shadow DOM, and keeping refs stable enough between snapshots to be useful.

Build:
- A snapshot from the accessibility tree (`Accessibility.getFullAXTree` or `DOMSnapshot`), compacted to roles, names, values and states (checked, disabled, expanded), indented by structure where that helps.
- **Refs** stored in `winstond`'s registry, mapping each ref to a stable node identity (for example `backendNodeId`) for that window, and valid until the next snapshot. Actions resolve refs through it.
- **`--full`** for more detail, including non-interactive text, when needed.
- **`--window <win_id>`** for a **read-only peek** at another run's window. That's how the front of house checks a page a background agent has open (§1).
- Output is bounded like all CLI output.

Tests: snapshot golden files for a set of saved test pages (a form, a search results page, a modal, an iframe), ref resolution, and peeks working without acquiring anything.
