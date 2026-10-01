---
id: "cfff20"
title: Create, update, delete and RSVP to calendar events
status: done
priority: none
labels:
  - connectors
  - m5
created_at: 2026-09-27T05:37:39.405Z
updated_at: 2026-10-01T16:47:35.552Z
blocked_by:
  - "403364"
---

The write side of the calendar provider (docs/design.md §11 `winston calendar`), with capability checks per operation (`create`, `update`, `delete`, `rsvp`) and audit rows for every write.

Research the tricky parts of the Calendar API:
- Recurring event instances vs series, and how "this and following" is actually implemented (it's a series split).
- `sendUpdates` for attendee notifications.
- Creating Meet links via `conferenceData.createRequest`.
- RRULE handling. Updating attendees without clobbering others' RSVP states.

Operations:
- **create:** `--title`, `--start`, and one of `--end`/`--duration`/`--all-day`. `--attendee` is repeatable. Also `--location`, `--description`, `--video`, `--repeat "<RRULE>"`, `--calendar`.
- **update:** any create field, plus `--add-attendee`/`--remove-attendee` and `--scope this|following|all` for recurring events.
- **delete:** `--scope` as well.
- **rsvp:** `--accept|--decline|--tentative`, `--note`, `--scope this|all`.
- **`--notify|--no-notify`:** notify defaults to on when there are attendees. That matters for confirm-first, since changing a shared meeting emails people.
- **`--dry-run`:** shows the resulting event and who would be notified.

Tests: request building for each operation (especially the scope semantics), dry-run output, and capability errors. Use mocked or recorded API responses.

## As built

- Provider writes in `googleCalendarProvider` (`@winston/connectors/google-calendar`, renamed from `googleCalendarReader` now that it writes); routes in `packages/vm-api/src/calendar-write.ts`. Details in docs/design.md (Google Calendar (write) as built, The calendar write routes).
- "This and following" is a series split (`UNTIL` one second before, then a new series from the occurrence). Series with `COUNT` refuse to split rather than guess.
- `--scope all` with a new time moves the series by the same amount the occurrence moved.
- Moving all-day events isn't supported yet (delete and recreate); nothing in M5 needs it.

