---
id: "5f5b39"
title: Snapshot pages as compact element lists with refs
status: done
priority: none
labels:
  - browser
  - cli
  - m8
created_at: 2026-09-27T05:42:03.691Z
updated_at: 2026-10-02T01:48:21.097Z
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

## As built

- `apps/winstond/src/browser/snapshot.ts`: accessibility tree to compact lines with refs on interactive elements; containers and headings for orientation; options inline; `--full` adds text. Frames: same-process by frame id, cross-site via auto-attached sessions, spliced at their `<iframe>` (`DOM.getFrameOwner`).
- Refs in winstond's registry (`{session, backendNodeId}`), stable per node, reset after main-frame navigation (Chrome reuses node ids across sites), numbers never reused in a window. `target()` resolves them for 0451df.
- `browser snapshot [--full] [--window]`; a peek is read-only, without refs, and doesn't touch the owner's state. Output capped at 300/600 lines.
- Tests: golden files (form, results, modal, iframes) from Chrome's recorded trees in `fixtures/`, ref stability, fresh refs after navigation, peeks.
- Found and fixed on the way (in 63475d's unit): Chrome refused to start on a moved profile volume (stale `SingletonLock` from another host); the unit now clears it before each start. Also noted the AMI built and passed its sandbox check.

