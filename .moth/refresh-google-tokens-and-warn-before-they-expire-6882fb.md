---
id: "6882fb"
title: Refresh Google tokens and warn before they expire
status: todo
priority: none
labels:
  - backend
  - connectors
  - m3
created_at: 2026-09-27T05:34:41.063Z
updated_at: 2026-09-27T05:34:41.096Z
blocked_by:
  - "4428cf"
---

The Google OAuth app stays in testing mode, so **refresh tokens expire 7 days after they're granted**. Winston warns the user ahead of time with a one-tap reconnect link (docs/design.md §5, Access control).

Build:
- An access-token helper used by every connector call: decrypt the refresh token, fetch or refresh an access token (cache it until shortly before expiry), and on `invalid_grant` mark the connection `expired`.
- A periodic job that marks connections `expiring` about a day before `granted_at + 7 days`, and produces the always-delivered items `system.app.auth_expiring` and `system.app.auth_expired`. Each carries the account and a direct reconnect link, so the front of house can nudge the user naturally.
- Reconnecting resets `granted_at` and the status.
- `/home` and `/accounts` show attention states for expiring and expired accounts, so fill those slots in now.

Be careful with duplicates: one `auth_expiring` per grant, not one per job run.

Tests: refresh and caching, `invalid_grant` flipping to expired, the expiring window computation, the one-event-per-grant guarantee, and reconnect resetting state.
