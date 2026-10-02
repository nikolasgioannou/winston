---
id: "0451df"
title: "Act on pages: click, type, select, press, scroll, wait"
status: done
priority: none
labels:
  - browser
  - cli
  - m8
created_at: 2026-09-27T05:42:03.745Z
updated_at: 2026-10-02T02:12:45.576Z
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

## As built

- `actions.ts` and `input.ts` in `apps/winstond/src/browser/`; CLI verbs click, type, select, press, scroll, click-xy, wait, plus `dialog accept|dismiss` (the ticket's "way to accept or dismiss").
- Trusted Input-domain events with human pauses; page checks in an isolated world (no `Runtime.enable`); overlay hit test with `elementFromPoint` (CDP's `getNodeForLocation` was unreliable on scrolled pages); native selects set Playwright-style.
- Settle: network quiet 500 ms + DOM quiet 300 ms (isolated-world MutationObserver), cap 5 s, 30 s while loading.
- Dialogs: alert/beforeunload auto-answered and reported; confirm/prompt held for `browser dialog`; actions don't wait on Chrome's held replies.
- Tests: CLI unit tests; `actions.chrome.test.ts` against a real Chrome (all actions, stale refs, overlay, dialogs, settle, popup from a real click, scrolling), skipped in CI; how to run it is in docs/design.md §11. Ran green three times locally.

