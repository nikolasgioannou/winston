---
id: "8fffdd"
title: Manage a connected account in a dialog
status: backlog
priority: none
labels:
  - m3
  - web
created_at: 2026-10-01T00:11:34.137Z
updated_at: 2026-10-01T00:11:34.251Z
blocked_by:
  - "856256"
---

The founder doesn't like the connected account detail page: clicking an account should open a dialog instead, laid out with cards, and the design will keep iterating from there.

- Clicking a row on `/accounts` opens a dialog for that account (reusing the dialog component from the add-account modal ticket): the provider and address at the top, then cards for what Winston can do (the capability switches, saving immediately as now) and for the connection (status, Reconnect, Disconnect with its confirmation).
- Keep it addressable: opening it puts the account in the URL (`/accounts?account=<id>`), so a reconnect or a link from Home can land on it; closing it returns to `/accounts`. The `/accounts/<id>` route goes.
- Update the dev design view (the dialog's states replace the account page's) and design.md §20.
