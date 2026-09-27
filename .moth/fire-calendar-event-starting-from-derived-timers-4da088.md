---
id: "4da088"
title: Fire calendar.event.starting from derived timers
status: todo
priority: none
labels:
  - agents
  - events
  - m7
created_at: 2026-09-27T05:40:24.796Z
updated_at: 2026-09-27T05:40:24.852Z
blocked_by:
  - "463072"
  - "e79d1c"
---

`calendar.event.starting` is an **abstraction**: it fires N minutes before an event starts, and it automatically follows moves and cancellations, so Winston doesn't have to reschedule wake-ups himself (docs/design.md §3, Primitives, abstractions & scoping).

Build `derived_timers`:
- When a `calendar.event.starting` subscription is created or updated, materialize timers for matching upcoming events within a rolling horizon (for example the next 7 days), with `fire_at = start − lead_minutes`, applying the subscription's filters.
- When calendar sync reports created, updated or cancelled events, add, move or delete the affected timers. The cal-sync ticket leaves a hook for this.
- A periodic job extends the horizon.
- The scheduler's `fire_derived_timer` job fires the timer as a `calendar.event.starting` event for that subscription. It goes through batching like any match, so two meetings starting at once produce one run.
- Deleting the subscription deletes its timers.

Tests: materialization with filters, a moved meeting moving its timer, cancellation deleting it, the horizon extension, and firing producing a correctly shaped event.
