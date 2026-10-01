---
id: "72b869"
title: Lay out profile fields as setting rows
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-10-01T01:29:46.900Z
updated_at: 2026-10-01T01:30:49.588Z
blocked_by:
  - "6341c5"
---

The founder's feedback on the reworked profile page:

- Lay out first name, last name and email as setting rows: the label on the left, the field on the right at a fixed width (as in Linear's profile settings). Names still save on blur, with "Saved" shown briefly; email stays disabled.
- Drop the description under "Delete account": the confirmation dialog already explains it.
- Update the dev design view and design.md §20.

## Outcome

- First name, last name and email are setting rows in the You card: label left, field right at one width (`w-56`, `w-64` from 640px). Names still save on blur; "Saved" now shows briefly under the label. Email stays disabled.
- Delete account has no description; the confirmation dialog explains it.
- Checked in the dev design view.

