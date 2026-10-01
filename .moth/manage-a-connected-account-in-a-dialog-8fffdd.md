---
id: "8fffdd"
title: Manage a connected account in a dialog
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-10-01T00:11:34.137Z
updated_at: 2026-10-01T00:27:51.392Z
blocked_by:
  - "856256"
---

The founder doesn't like the connected account detail page: clicking an account should open a dialog instead, laid out with cards, and the design will keep iterating from there.

- Clicking a row on `/accounts` opens a dialog for that account (reusing the dialog component from the add-account modal ticket): the provider and address at the top, then cards for what Winston can do (the capability switches, saving immediately as now) and for the connection (status, Reconnect, Disconnect with its confirmation).
- Keep it addressable: opening it puts the account in the URL (`/accounts?account=<id>`), so a reconnect or a link from Home can land on it; closing it returns to `/accounts`. The `/accounts/<id>` route goes.
- Update the dev design view (the dialog's states replace the account page's) and design.md §20.

## Outcome

- Clicking an account on `/accounts` opens `AccountDialog` (on the new `Dialog`) at `/accounts?account=<id>`; closing it goes back to `/accounts`. The loader fetches the open account alongside the list, and an id that isn't the user's (or is gone) just doesn't open. `/accounts/<id>` and the account page are gone.
- The dialog: the address as its title, the provider with a type badge under it, the status callout with Reconnect, then two cards: "What Winston can do" (the switches, saving immediately as before) and "Connection" (Reconnect, Disconnect with its confirmation, which nests over the dialog).
- The saving logic moved into a `useCapabilitySaves` hook.
- Dev design view: "Account dialog" shows each state over the accounts list.
- Checked live on the founder's personal mail: opening from the list put the account in the URL, closing cleared it, and toggling Organize inside the dialog saved ("Saved") and was restored.

