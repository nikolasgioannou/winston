---
id: "403364"
title: Read calendars from Google Calendar
status: todo
priority: none
labels:
  - connectors
  - m5
created_at: 2026-09-27T05:37:39.353Z
updated_at: 2026-09-27T05:37:39.388Z
blocked_by:
  - "480aff"
---

The Google Calendar implementation of `CalendarProvider`'s read side (docs/design.md §11 `winston calendar`).

Research the Calendar API: `events.list` (`singleEvents` expansion of recurring events, `timeMin`/`timeMax`, `orderBy`), all-day vs timed events and their time zones, attendees and `responseStatus`, `conferenceData`, the calendar list (primary vs others), and `freebusy.query`.

Behaviour:
- **list:** the default range is now to +7 days. `--calendar <name|id>` (default: all the user's calendars that are selected in Google, or just primary; decide). Filters: `--attendee`, `--organizer`, `--external` (attendees outside the user's own email domain), `--title`.
- **search:** the text query plus filters.
- **get:** the full event, including description, attendees with RSVP status, location, video link and recurrence.
- **free:** free slots between `--since` and `--until` of at least `--duration`, from the user's own calendars plus `--attendee` free/busy where visible. Handle working-hours defaults sensibly. Think about what an assistant scheduling a meeting actually needs. Probably: weekdays, reasonable hours in the user's zone, configurable per call.

Everything is returned in normalized shapes with times in the user's zone.

Tests with recorded responses: recurring event expansion, all-day events across zones, `--external` classification, and free-slot computation (a pure function, so test it heavily, including DST days).
