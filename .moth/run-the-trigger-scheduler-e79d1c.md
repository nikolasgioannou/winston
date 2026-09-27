---
id: "e79d1c"
title: Run the trigger scheduler
status: todo
priority: none
labels:
  - agents
  - events
  - m7
created_at: 2026-09-27T05:40:24.252Z
updated_at: 2026-09-27T05:40:24.287Z
blocked_by:
  - "3f6521"
---

The scheduler loop turns time into trigger runs (docs/design.md §9 Scheduler in Postgres, §17 Scheduler loop). It runs in `agents` every few seconds, and it must behave correctly with several `agents` tasks running, so exactly one of them fires each due trigger.

Each tick:
- Schedules with `next_fire_at <= now()` get a `fire_schedule` job (dedupe key per trigger and occurrence). The job starts the run and advances `next_fire_at`, or exhausts one-off schedules.
- Triggers past `expires_at` get an `expire_trigger` job. It marks them `expired` and starts an `on_expire` run if they fired fewer than `max_fires` times.
- Due `derived_timers` get `fire_derived_timer` jobs. The derived-timers ticket fills in the handler.

Use the job queue's dedupe keys so overlapping ticks and multiple scheduler instances can't double-enqueue. Research whether a simple `pg_try_advisory_lock` leader election is cleaner than relying on dedupe alone.

Decide missed-fire semantics after downtime: a schedule that should have fired while the system was down fires once on recovery, not once per missed occurrence. Note it in §17.

Tests with a controllable clock: one-off and cron firing, a single fire under concurrent schedulers, expiry with and without `on_expire`, and missed-fire catch-up firing once.
