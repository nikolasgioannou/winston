---
id: "88f5ee"
title: Add trigger tables and encode the trigger lifecycle
status: todo
priority: none
labels:
  - db
  - events
  - m7
created_at: 2026-09-27T05:40:24.057Z
updated_at: 2026-09-27T05:40:24.092Z
blocked_by:
  - "9c407f"
---

Triggers are how Winston decides what wakes him up: **schedules** (one-off `at`, or recurring `cron`) and **subscriptions** to catalog events (docs/design.md §3). Their lifecycle fields are what make one-shot follow-ups and "notice when nothing happens" possible (§3, Trigger lifecycle).

Add the tables from §14: `triggers`, `trigger_batches` and `derived_timers`. Then encode the lifecycle rules as **pure functions** next to them, since the scheduler, the matcher and the CLI all need the same answers:
- `max_fires`: `fire_count` reaching it makes the trigger `exhausted`.
- `expires_at`: after it passes, the trigger becomes `expired`. If `fire_count < max_fires` and there's an `on_expire_note`, an expiry run is due.
- `next_fire_at` for schedules: one-off `at`, or the next cron occurrence **in the user's time zone**. Research a cron library that handles time zones and DST correctly (croner, cron-parser), and check behaviour across DST transitions.
- `deleted` is terminal and excluded from everything.

Tests (pure, table-driven): each lifecycle transition, expiry with and without fires, and cron next-occurrence across DST in America/New_York (for example, a 2:30am daily job on the spring-forward day).
