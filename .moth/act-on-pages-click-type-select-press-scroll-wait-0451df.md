---
id: "0451df"
title: "Act on pages: click, type, select, press, scroll, wait"
status: todo
priority: none
labels:
  - browser
  - cli
  - m8
created_at: 2026-09-27T05:42:03.745Z
updated_at: 2026-09-27T05:42:03.781Z
blocked_by:
  - "5f5b39"
---

Actions by ref, plus a coordinate fallback (docs/design.md §11 `winston browser`):
- `click <ref>`, `type <ref> <text> [--submit] [--clear]`, `select <ref> <option>`, `press <key>`, `scroll [--down|--up|--to <ref>]`.
- `click-xy <x> <y>` for canvas, some iframes and shadow DOM.
- `wait [--for <text|ref>] [--timeout <d>]`.

Research how to produce **trusted, human-like input** via CDP (`Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText`), scrolling elements into view first, clicking at the element's visible center, and handling elements covered by overlays. Also, how to decide that a page has **settled** after an action: network quiet plus no DOM mutations for a short window, bounded by a timeout. Stable pages matter a lot for reliability.

Each action returns a short result describing what happened: the URL if it changed, a new dialog or popup opened, the element no longer existing. The agent can then decide whether to snapshot again. Stale refs (from before the page changed) fail with exit code 1 and "take a new snapshot."

Handle JavaScript dialogs (`alert`, `confirm`, `beforeunload`) so they don't hang the page. Surface them in the action result, with a way to accept or dismiss.

Tests against saved test pages in a harness Chrome: each action, stale refs, overlays, dialogs, and the settle logic.
