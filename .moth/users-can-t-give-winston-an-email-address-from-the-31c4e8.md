---
id: "31c4e8"
title: Users can't give Winston an email address from the site
status: todo
priority: none
labels:
  - ui
  - web
parent: "ead827"
created_at: 2026-10-04T02:55:27.547Z
updated_at: 2026-10-04T02:55:34.703Z
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

- [ ] A user can set up, copy, change (until the limit) and turn off the address from Channels, and every error shows its reason
- [ ] Winston can send a link that opens the set-up dialog
- [ ] Every state is in the dev design view
