---
id: "4428cf"
title: Connect Google mail and calendar accounts
status: done
priority: none
labels:
  - backend
  - connectors
  - m3
  - web
created_at: 2026-09-27T05:34:40.928Z
updated_at: 2026-09-30T03:51:09.049Z
blocked_by:
  - "35fdd4"
  - "5e3c6d"
  - "ef5b35"
---

Connected apps are separate from sign-in. The user connects any number of accounts per domain, such as work mail, personal mail and personal calendar (product.md §1, docs/design.md §5, Connections & credentials).

Build:
- The `/accounts` page: a list of connections (alias, domain, provider, email, status), an empty state, and an **Add account** action that asks for the domain (mail or calendar) and starts Google OAuth with that domain's scopes (from the GCP ticket), `access_type=offline` and `prompt=consent` so a refresh token is always issued.
- The OAuth callback in `api`: exchange the code, confirm the granted scopes (the user can untick some on Google's screen, so record what was actually granted), store the connection with the encrypted refresh token, and set `granted_at` (testing-mode tokens expire in 7 days).
  - The default alias comes from the email domain, for example "work" for a Workspace domain and "personal" for gmail.com. The user can rename it.
  - **Default capability toggles:** read on. For writes, the conservative default is "draft on, send off" for mail. Confirm defaults with the founder when you get here.
- Connecting an account that already exists updates its tokens instead of duplicating it.
- Produce the `system.app.connected` item so Winston knows. Event delivery is fully wired in M7, but the always-delivered inbound path exists now.

Add `/accounts` states to the dev design view: empty, a few accounts, one expiring, one expired.

Tests: the callback stores encrypted tokens and granted scopes, reconnecting updates rather than duplicates, and the DTO never includes the token.

## Outcome

- **Callback in `web`, not `api`** (the founder's call): only the site can tie the finishing browser to the signed-in user who started, so a forwarded link can't attach someone else's account. The site only encrypts (KMS `GenerateDataKey` without `Decrypt` in production). The connect redirect URI moved to `/auth/google/connect/callback` on the site in the runbook; the dev client needs it added.
- **Default toggles** (the founder's call, conservative): mail read and draft on, send and labels off; calendar read on, the rest off (`defaultCapabilities`).
- Flow: `/auth/google/connect?domain=` (or `?reconnect=<acct_id>`, which sends the account as `login_hint`) asks for `openid email` plus the domain's scopes, offline with forced consent. The callback checks the session and state, requires the essential scope (`gmail.modify` / `calendar.events`), records only the domain scopes actually granted, and `saveConnection` refreshes an existing connection (same id, alias and toggles kept) or creates one with a unique default alias ("personal" / "work", then the company or address name, then numbered). A new one records `system.app.connected` through a new `recordSystemEvent` (inbound item plus debounced turn), and the prompt says to acknowledge it briefly.
- Google helpers now share the token exchange and ID token check between sign-in and connecting; `GoogleSignInError` became `GoogleAuthError`.
- `/accounts`: connections as DTOs (selected with `connectionDtoColumns`), status pills and Reconnect for anything not `ok`, **Add account** as a new `Menu` component in `packages/ui`, an empty state, and toasts after connecting. `/home` now counts real connections.
- Dev design view: empty, a few accounts, one expiring, one expired (checked at desktop and mobile widths, menu included).
- Tests: the stored token decrypts only with its connection's context and never appears in the DTO; granted scopes, defaults and the connected event are recorded; reconnecting updates instead of duplicating (and doesn't announce again); a second account gets its own alias; a partial calendar grant keeps what was granted; a missing essential scope, a bad state, a cancelled consent, an unknown domain or no refresh token save nothing; the connect URL's parameters; default aliases.
- Not yet checked live against Google: it needs the dev client's new redirect URI and a real consent in the founder's browser.

