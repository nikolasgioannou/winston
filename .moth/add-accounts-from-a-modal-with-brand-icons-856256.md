---
id: "856256"
title: Add accounts from a modal, with brand icons
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-09-30T22:21:08.201Z
updated_at: 2026-10-01T00:19:20.150Z
blocked_by:
  - "75bfa7"
  - "bf0135"
  - "ee16f5"
---

The founder's feedback after M3: a dropdown won't scale to the providers Winston will support, and accounts should be recognisable at a glance.

- **Add account opens a modal** (a new dialog component in `packages/ui` if `ConfirmDialog` doesn't fit): options grouped by type (a Mail heading with Gmail, a Calendar heading with Google Calendar, more groups later), each a row with the brand icon and name that starts the connect flow. Built from a list, so a new provider is one entry.
- **Brand icons** for Gmail, Google Calendar and Telegram. Research each brand's official assets and usage rules first (Google's and Telegram's brand guidelines, as for the Google sign-in button), and use sanctioned artwork, recorded in design.md with its source.
- Use them beyond the modal: account list rows (replacing the generic mail and calendar icons next to the provider name and type badge), the account page header, and the Telegram card or step on Profile and Home.
- Delete the `Menu` component, which nothing else uses.
- Dev design view: the modal open.

Done autonomously with the rest of this batch; the founder reviews it all at the end.

## Outcome

- Add account opens a new `Dialog` (`packages/ui`, on Base UI's Dialog: title, close button, scrolling body; trigger-opened or controlled, which the account dialog will use) listing what can be connected, grouped by type, from one catalog (`connectableProviders` in `src/components/providers.tsx`). Each option is a `LinkCard` row that starts its connect flow. The empty state offers the same dialog. `Menu` is deleted.
- Brand research (2026-09-30):
  - **Telegram** lets anyone use its logo for buttons as long as it's clear we aren't Telegram, so `TelegramIcon` is its mark in Telegram's blue (a CC0 path from Simple Icons). It goes on the Telegram card in the profile rework.
  - **Google** requires permission (via its Partner Marketing Hub) before third parties show product icons like Gmail's and Calendar's. So `ProviderIcon`, the one place they're drawn, shows neutral icons for now. **Needs the founder:** request permission, or decide otherwise.
- Account rows use `ProviderIcon` in an `IconTile`.
- Dev design view: Connected accounts gains "Add account" (the dialog open). Checked it renders.
- **Follow-up (2026-10-01):** the founder chose to use the Gmail and Google Calendar icons now, since Winston is private and friends-only, and to ask Google before any wider launch. `GmailIcon` and `GoogleCalendarIcon` (`packages/ui`) are Google's 2026 artwork, unmodified, copied from thesvg (MIT; checked to be plain artwork), with per-instance ids. `ProviderIcon` uses them in the account rows, the Add account dialog and the account dialog.

