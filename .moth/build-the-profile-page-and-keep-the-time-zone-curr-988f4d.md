---
id: "988f4d"
title: Build the profile page and keep the time zone current
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-09-27T05:34:41.112Z
updated_at: 2026-09-30T04:53:37.687Z
blocked_by:
  - "5e3c6d"
---

`/profile` shows and edits the user's first and last name, shows their email (read-only), and shows and edits their time zone (docs/design.md §20). It's also where the account actions live (the founder moved them out of the sidebar): the **Telegram** link section (from the Telegram-linking ticket), **Sign out** (already on the placeholder page) and a **Delete account** section that opens the deletion flow from the account-deletion ticket.

Time zone behaviour matters, because it determines how every timestamp is rendered and when schedules fire (§4 envelope, §11):
- Captured from the browser at sign-up (the sign-in ticket).
- **Whenever the web app is opened and the browser's time zone differs from the saved one, it updates automatically.** Do this once per app load in the shell, not only on `/profile`. Show a subtle notice, not a modal.
- Editable manually on `/profile`, with a searchable IANA zone picker.
- Every change produces the `system.settings.changed` item (field, old, new), so Winston knows. The CLI path (`winston me update --timezone`) from M2 must produce the same item. Unify both through one backend function.

Add the page's states to the dev design view.

Tests: the auto-update only fires on a real difference, both paths produce one `settings.changed` item, and zone validation.

## Outcome

- `/profile`: name form, read-only email, a searchable time zone picker (new `SearchSelect` in `packages/ui`, on Base UI's combobox), the Telegram section and Sign out. **Delete account** is left to its own ticket (22f09d), which builds the flow this section opens.
- `updateProfile` (`@winston/db/profile`) is the one path for the site, the browser and the CLI's `PATCH /v1/me`: canonical IANA zones, trimmed names, and one `system.settings.changed` per field that really changes (field, old, new, source). The three separate zone checks became `canonicalTimeZone`/`isTimeZone` in `@winston/shared/time`.
- The shell follows the browser's zone once per load, with a quiet toast. The site's `Toaster` had never been mounted, so no toast had shown anywhere (including after connecting accounts); it's now in the root layout.
- The front-of-house prompt needs no change: `settings.changed` arrives as an outside event, and its `source` tells Winston whether it made the change itself.
- Tests: changes record one event per changed field, unchanged values record nothing (so the auto-update only fires on a real difference), zone and name validation, and the CLI path recording the same event with source `winston`.
- Checked live: with the saved zone set to Tokyo, opening the site in a New York browser saved New York, showed the notice and recorded one `settings.changed` from `browser`; the picker filters ("tokyo" → Asia/Tokyo).

