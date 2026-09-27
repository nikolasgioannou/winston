---
id: "fe870e"
title: Add winston accounts and the generic winston get
status: todo
priority: none
labels:
  - cli
  - m5
created_at: 2026-09-27T05:37:39.524Z
updated_at: 2026-09-27T05:37:39.558Z
blocked_by:
  - "480aff"
---

Two cross-cutting commands (docs/design.md §11):
- **`winston accounts list`:** each connection's `acct_` id, alias, domain, provider, email and status (ok, auth expiring, expired).
- **`winston accounts get <acct_id|alias>`:** the same, plus capabilities with their toggle state, the calendars on that account (for calendar connections), and provider-specific notes. For example, "search uses Gmail query syntax with `--native`," which is the capability discovery from §3.
- **`winston get <any-id>`:** resolves any prefixed id by its prefix, and prints it as that resource's `get` would. Make the resolver a registry that later resources (triggers, tasks, history, windows) plug into, so adding a resource doesn't mean editing a giant switch.

Tests: every registered prefix routes correctly, unknown and malformed ids give exit code 1 with a hint, and `accounts get` shows a disabled capability clearly.
