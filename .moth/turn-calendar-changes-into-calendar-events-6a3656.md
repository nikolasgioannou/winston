---
id: "6a3656"
title: Turn calendar changes into calendar events
status: done
priority: none
labels:
  - connectors
  - events
  - m7
created_at: 2026-09-27T05:40:24.585Z
updated_at: 2026-10-01T19:26:30.214Z
blocked_by:
  - "a2d498"
---

The `sync_connection` handler for calendars: incremental `events.list` with each calendar's stored `syncToken`, turned into catalog events (docs/design.md §3 calendar table, §17).

Research the details: incremental sync semantics (deleted events appear with `status: cancelled`), **410 Gone** meaning the sync token is invalid (do a full resync of a bounded window and reset), pagination (`nextSyncToken` only on the last page), and recurring events and instances in incremental results.

Producing `calendar.event.updated` with a **field-level diff (before/after)** needs the previous state of each event. Add a small snapshot store (per connection, calendar and event id) holding the fields we diff: time, location, attendees and their RSVP, description, conferencing. Update §14 with it.

Events to emit:
- `calendar.invitation.received`: a new event where someone else is the organizer and the user is an attendee.
- `calendar.event.created`: created on the user's calendar, by the user or by Winston (flag `self_caused` via the audit log).
- `calendar.event.updated`: with the diff. Skip changes that touch no diffed field.
- `calendar.event.cancelled`: with who cancelled, if known.
- `calendar.rsvp.changed`: an attendee's response changed on one of the user's events.

Use dedupe keys and advance sync tokens only after events are stored. When an event's time changes, notify the derived-timers logic (next tickets) so `calendar.event.starting` timers follow it.

Tests with recorded fixtures: each event kind, diff contents, 410 recovery, recurring instances, and dedupe on re-run.

## As built

- `syncCalendar` in `apps/agents/src/connections/sync-calendar.ts`; the incremental listing and 410 handling in `@winston/connectors/google-calendar-sync`; snapshots in `calendar_event_snapshots` (§14). Details in docs/design.md §3 (Calendar sync as built).
- Recurrences aren't expanded in sync: a series is one event, and instances that move or are cancelled come separately and are described from the series. `calendar.event.starting` timers expand upcoming instances themselves (4da088).
- Derived timers follow time changes through the stored `calendar.event.updated` / `cancelled` events, which matching (463072) and timers (4da088) consume; nothing extra is needed here.
- Tested on fixture events rather than recorded responses, so no real calendar data is in the repository.

