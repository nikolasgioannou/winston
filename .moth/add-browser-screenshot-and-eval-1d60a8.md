---
id: "1d60a8"
title: Add browser screenshot and eval
status: todo
priority: none
labels:
  - browser
  - cli
  - m8
created_at: 2026-09-27T05:42:03.798Z
updated_at: 2026-09-27T05:42:03.834Z
blocked_by:
  - "6b73c4"
---

Two tools the agent uses to verify and to escape (docs/design.md §5 Browser):
- **`browser screenshot [--window <win_id>] [--full-page]`:** captures the target with `Page.captureScreenshot` (per target, so it works for background windows) and saves a PNG under `~/.winston/screenshots/<run>/`. It **prints the path**, and the agent looks at it with `view_image`. `--window` supports the front of house's read-only peeks. Research full-page capture for long pages, and a sensible default viewport and device scale factor, so screenshots are legible without being huge.
- **`browser eval <js>`:** runs JavaScript in the page and prints the result (JSON-serialized, truncated like all output). Accepts `-` and `@path` for longer scripts. It's the code escape hatch that the research found was the biggest single quality gain for browser agents, used for extraction and bulk work. Run it without leaving `Runtime.enable` on (the approach from the CDP ticket), and in an isolated world where possible, so page scripts can't observe it.

Tests: the screenshot path and file are produced for a background window, the full-page toggle, eval result serialization and truncation, and eval errors surfacing clearly.
