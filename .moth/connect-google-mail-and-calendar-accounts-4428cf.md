---
id: "4428cf"
title: Connect Google mail and calendar accounts
status: todo
priority: none
labels:
  - backend
  - connectors
  - m3
  - web
created_at: 2026-09-27T05:34:40.928Z
updated_at: 2026-09-27T05:34:40.996Z
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
