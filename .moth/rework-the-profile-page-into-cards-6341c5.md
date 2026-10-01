---
id: "6341c5"
title: Rework the profile page into cards
status: backlog
priority: none
labels:
  - m3
  - web
created_at: 2026-09-30T22:21:08.239Z
updated_at: 2026-10-01T00:11:34.287Z
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
