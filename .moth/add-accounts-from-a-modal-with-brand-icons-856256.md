---
id: "856256"
title: Add accounts from a modal, with brand icons
status: backlog
priority: none
labels:
  - m3
  - web
created_at: 2026-09-30T22:21:08.201Z
updated_at: 2026-09-30T22:21:21.407Z
blocked_by:
  - "75bfa7"
  - "ee16f5"
---

The founder's feedback after M3: a dropdown won't scale to the providers Winston will support, and accounts should be recognisable at a glance.

- **Add account opens a modal** (a new dialog component in `packages/ui` if `ConfirmDialog` doesn't fit): options grouped by type (a Mail heading with Gmail, a Calendar heading with Google Calendar, more groups later), each a row with the brand icon and name that starts the connect flow. Built from a list, so a new provider is one entry.
- **Brand icons** for Gmail, Google Calendar and Telegram. Research each brand's official assets and usage rules first (Google's and Telegram's brand guidelines, as for the Google sign-in button), and use sanctioned artwork, recorded in design.md with its source.
- Use them beyond the modal: account list rows (replacing the generic mail and calendar icons next to the provider name and type badge), the account page header, and the Telegram card or step on Profile and Home.
- Delete the `Menu` component, which nothing else uses.
- Dev design view: the modal open.

Pause for the founder's review before committing.
