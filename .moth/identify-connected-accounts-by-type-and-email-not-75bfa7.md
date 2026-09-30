---
id: "75bfa7"
title: Identify connected accounts by type and email, not aliases
status: backlog
priority: none
labels:
  - m3
  - web
created_at: 2026-09-30T22:21:08.160Z
updated_at: 2026-09-30T22:21:21.369Z
blocked_by:
  - "89a2b0"
---

The founder's feedback after M3: connected accounts shouldn't have names ("personal", "work"). An account is identified by its type (Mail, Calendar) and its address.

- **Data:** drop `connections.alias`, its per-user-and-domain unique constraint, `aliasPattern`, `defaultAlias`, `renameConnection` and their tests. The `system.app.connected`, `…disconnected` and `auth_*` payloads lose `alias`, and Home's attention items and the prompt stop using it.
- **Accounts list:** each row is "Mail" or "Calendar" with the address under it. Also fix the row hover: the highlight should span the card's full width, not stop short of its edges.
- **Account page:** the address as the title, with "Gmail" or "Google Calendar" under it; the Name section goes.
- **Docs:** design.md's CLI spec moves from `--account <alias>` to `--account <email>` (still optional when the user has one account of that type), `accounts get` takes an id or an address, and Winston names accounts by address in chat. Update §12a, §14 and §20 to match.

Pause for the founder's review before committing.
