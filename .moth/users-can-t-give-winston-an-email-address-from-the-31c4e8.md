---
id: "31c4e8"
title: Users can't give Winston an email address from the site
status: done
priority: none
labels:
  - ui
  - web
parent: "ead827"
created_at: 2026-10-04T02:55:27.547Z
updated_at: 2026-10-04T03:24:39.569Z
blocked_by:
  - "32ddbd"
  - "ee533c"
---

The Channels page lists Telegram, but there's no way for a user to give Winston an email address (ead827).

**What to build**

- An **Email** row on Channels: "Winston's email address". Off: **Set up** opens a dialog to pick the name, checking availability as you type, previewing `<name>@runwinston.email`, and noting that addresses are never reused. On: the address with **Copy**, and an ⋯ menu with **Change address** (says how many changes are left and that the old address keeps working) and **Turn off** (after a confirmation that explains mail will bounce until it's on again).
- A link that opens the set-up dialog (`/channels?email=setup`), and a way for Winston to send it (as `winston accounts connect` does for accounts).
- Dev design view states: off, setting up (available, taken, invalid, reserved), on, changing, no changes left, turned off.
- `design.md` §20 updated.

**Done when**

- [x] A user can set up, copy, change (until the limit) and turn off the address from Channels, and every error shows its reason
- [x] Winston can send a link that opens the set-up dialog
- [x] Every state is in the dev design view

## As built

The Email row on Channels (`EmailRow` in `channels-page.tsx`) and `MailboxDialog` (`components/mailbox-dialog.tsx`) for setting up and changing the address, over server functions in `server/channels-functions.ts` that call `@winston/db/mailbox`. The design system's `TextField` gained a `suffix` for the domain. `/channels?email=setup` opens the set-up dialog.

**Differs from the plan:**
- **The link reaches Winston through `winston accounts connect mail`** rather than a new command: its response carries `winstonMailbox` (status, address, link), and the CLI says he has no address yet with the set-up link, what it is, or that it's off and where to turn it on. That kept the CLI's grammar as it is (§11).
- **Copy is in the ⋯ menu**, not a button on the row, so the row matches Telegram's (badge plus menu). **Change address** leaves the menu once both changes are used, rather than opening a dialog that says so.
- **Copy is minimal:** "You can change it twice." under the field and the turn-off confirmation; the never-reused rule isn't spelled out on the site.

Checked in the dev design view (every state), and typing a taken then a free name in the set-up dialog flagged one and enabled the button for the other. Tests cover the connect route and the CLI's lines.
