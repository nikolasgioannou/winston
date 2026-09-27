---
id: "6b73c4"
title: Connect the CLI to Chrome and manage agent windows
status: todo
priority: none
labels:
  - browser
  - cli
  - m8
created_at: 2026-09-27T05:42:03.620Z
updated_at: 2026-09-27T05:42:03.675Z
blocked_by:
  - "63475d"
  - "fe870e"
---

`winston browser` talks to the local Chrome over CDP directly. Every run owns **its own window** in the shared profile (docs/design.md §5 Browser, §11 `winston browser`).

Research first, because the choices here affect reliability and detectability:
- **CDP client:** `chrome-remote-interface` vs a minimal client over a websocket (the research favoured raw CDP). Check Bun compatibility and binary size in the compiled CLI.
- **Detection:** **avoid leaving `Runtime.enable` on**, since pages can detect it (docs/research/browser-agents.md). Find how to evaluate and inspect without it, for example using isolated worlds and `Runtime.evaluate` with a specific context, or `Page.createIsolatedWorld`.
- **Windows vs tabs:** creating separate windows via `Target.createTarget` with `newWindow: true`, and keeping each agent's window unthrottled.

State lives in **`winstond`**, since the CLI is a short-lived process: a registry of windows (`win_` id → CDP target id, owning run, URL), exposed to the CLI over the unix socket. Clean up windows whose runs ended.

Commands in this ticket:
- **`browser windows`:** all windows with owner run, URL and locks (locks arrive in the locks ticket).
- **`browser open [<url>]`:** a new window owned by this run, printing its `win_` id.
- **`browser navigate <url> | --back | --forward`**, waiting for load sensibly.
- **`browser close`.**

Commands act on the run's own window by default. Register `win_` with the `winston get` resolver. Research how to handle pages that open new windows (`window.open`, `target=_blank`): attach them to the same run, and make that visible.

Tests: registry ownership and cleanup, commands defaulting to the run's window, and the navigation wait logic against a local test page served inside the VM or a test harness Chrome.
