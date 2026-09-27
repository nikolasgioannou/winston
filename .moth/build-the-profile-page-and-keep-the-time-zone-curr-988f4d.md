---
id: "988f4d"
title: Build the profile page and keep the time zone current
status: todo
priority: none
labels:
  - m3
  - web
created_at: 2026-09-27T05:34:41.112Z
updated_at: 2026-09-27T05:34:41.146Z
blocked_by:
  - "5e3c6d"
---

`/profile` shows and edits the user's first and last name, shows their email (read-only), and shows and edits their time zone (docs/design.md §20).

Time zone behaviour matters, because it determines how every timestamp is rendered and when schedules fire (§4 envelope, §11):
- Captured from the browser at sign-up (the sign-in ticket).
- **Whenever the web app is opened and the browser's time zone differs from the saved one, it updates automatically.** Do this once per app load in the shell, not only on `/profile`. Show a subtle notice, not a modal.
- Editable manually on `/profile`, with a searchable IANA zone picker.
- Every change produces the `system.settings.changed` item (field, old, new), so Winston knows. The CLI path (`winston me update --timezone`) from M2 must produce the same item. Unify both through one backend function.

Add the page's states to the dev design view.

Tests: the auto-update only fires on a real difference, both paths produce one `settings.changed` item, and zone validation.
