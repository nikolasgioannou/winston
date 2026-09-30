---
id: "6882fb"
title: Refresh Google tokens and warn before they expire
status: done
priority: none
labels:
  - backend
  - connectors
  - m3
created_at: 2026-09-27T05:34:41.063Z
updated_at: 2026-09-30T04:44:58.755Z
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

## Outcome

- Grant sweep in `agents`, every 5 minutes (the gateway sweeper's pattern; there's no scheduler loop yet): `expiring` from 6 days after `granted_at`, `expired` after 7. Each move records `system.app.auth_expiring` / `auth_expired` with the account, `expiresAt` and a `reconnectUrl` (new `WEB_PUBLIC_URL` in agents config). The source ref names the grant, so it's one event per grant no matter how many runs or refresh failures; a reconnect's new `granted_at` starts over.
- `googleAccessTokens`: checks the connection is usable on every call, decrypts the refresh token, refreshes and caches the access token in memory until a minute before expiry; `invalid_grant` marks it expired (same once-per-grant event) and throws `ConnectionUnavailableError`. Nothing calls Google yet, so it isn't wired into a service; M5's connectors will be the first callers (and need the Google client config in whichever service runs them).
- `/home` lists expired, then expiring, accounts as attention items with Reconnect (a full-page link, since it's a server route). `/accounts` and the account page already show the states.
- Front-of-house prompt: nudge once, in a line, with the reconnect link.
- Tests: the window (before, during and after the warning), one event per grant across repeated sweeps, the expired event, reconnect resetting the grant and warning again, disconnected connections left alone, refresh with the decrypted token and caching until near expiry, `invalid_grant` flipping to expired and failing later calls without asking Google, other failures leaving the connection alone, and Home's attention items.

