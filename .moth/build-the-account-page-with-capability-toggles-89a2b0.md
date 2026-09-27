---
id: "89a2b0"
title: Build the account page with capability toggles
status: todo
priority: none
labels:
  - connectors
  - m3
  - web
created_at: 2026-09-27T05:34:41.012Z
updated_at: 2026-09-27T05:34:41.047Z
blocked_by:
  - "4428cf"
---

`/accounts/<acct_id>` manages one connection: its alias, its capability toggles, reconnecting and disconnecting (docs/design.md §5 Permissions, §20).

- **Capabilities** per domain (§5): mail has `read`, `draft`, `send` and `modify_labels`. Calendar has `read`, `create`, `update`, `delete` and `rsvp`. Toggles save immediately, with clear saving and saved feedback. A capability whose Google scope wasn't granted is shown as unavailable, with a "reconnect to enable" action.
- **Alias:** editable, unique per user and domain, and shell-safe, since the CLI uses it (`--account work`). Validate accordingly.
- **Reconnect:** re-runs OAuth for that account.
- **Disconnect:** a confirmation dialog, then revoke the token with Google, mark the connection `disconnected`, and produce `system.app.disconnected`. Automatically cancelling the triggers scoped to this connection is wired in M7. Leave a clear hook for it.

The toggles are what the backend enforces on every connected-app call (M5). This page is only the UI and storage. Make sure the stored shape is exactly what the enforcement layer will read.

Add all states to the dev design view: toggles saving, toggle error, unavailable capability, disconnect confirmation, disconnected.

Tests: toggle updates, alias validation, disconnect revoking the token (with a stubbed Google) and flipping status.
