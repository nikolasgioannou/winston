---
id: "6341c5"
title: Rework the profile page into cards
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-09-30T22:21:08.239Z
updated_at: 2026-10-01T00:32:50.238Z
blocked_by:
  - "22f09d"
  - "856256"
  - "8fffdd"
---

The founder's feedback after M3 on `/profile`:

- **Cards layout:** a titled card each for **You** (first and last name, email), **Telegram**, and **Account** (sign out and delete account).
- **Names save on blur**, no Save button, with a quiet "Saved" confirmation. Clearing the first name puts the saved one back instead of erroring.
- **Email** in a disabled input, with no explanation text.
- No "Winston calls you by your first name" hint.
- **No time zone on the page.** It's still set automatically from the browser when it differs (the shell's check stays). Delete `SearchSelect` and the time zone options module, which nothing else uses.
- Update the dev design view's Profile states and design.md §20.

Done autonomously with the rest of this batch; the founder reviews it all at the end.

## Outcome

- `/profile` is three titled cards: **You** (first and last name, email in a disabled field), **Telegram** (Telegram's mark, the @username or "Not linked", Connect/QR or Link another account) and **Account** (Sign out, Delete account).
- Names save on blur, each showing "Saved" under it for 2 seconds; no Save button and no hint. Clearing the first name, or a failed save, puts the saved value back.
- No time zone on the page: `SearchSelect`, the zone list and the site's manual zone saving are deleted (`saveProfile` now takes names only); the browser sync stays.
- `SettingRow` gained an optional `icon` (shown in an `IconTile`), used for the Telegram mark.
- Checked live on the founder's profile: a last-name change saved on blur with "Saved", clearing the first name restored it, and the original name was put back.

