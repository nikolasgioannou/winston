---
id: "0512b5"
title: Wire the system events into subscriptions
status: done
priority: none
labels:
  - events
  - m7
created_at: 2026-09-27T05:40:24.869Z
updated_at: 2026-10-01T19:47:51.579Z
blocked_by:
  - "463072"
  - "89a2b0"
  - "988f4d"
---

Several system events are produced in earlier tickets. This ticket makes sure they all flow through the catalog and matching properly (docs/design.md §3, System events):
- **`system.app.connected` / `system.app.disconnected`:** on disconnect, **automatically cancel every subscription scoped to that connection** (the account-detail ticket left a hook for this), and include in the payload which triggers were cancelled, so Winston can update his notes. Watches and channels are stopped by the push tickets.
- **`system.settings.changed`:** subscribable. When the **time zone changes**, recompute `next_fire_at` for cron schedules. The same local time in the new zone is what a user expects: "9am every weekday" should follow them to London.
- **Always-delivered events** (`onboarding.completed`, `auth_expiring`/`auth_expired`): confirm they go straight to the front of house, and aren't subject to subscription matching.

Tests: disconnect cancels exactly the scoped triggers and reports them, a time-zone change recomputes schedules correctly, and always-delivered events bypass matching.

## As built

- `recordSystemEvent` stores subscribable system events in `events` (dedupe `system:<sourceRef>`) and queues `match_events` (new job, `matchEventsHandler` in `apps/agents/src/triggers/matching.ts`). Always-delivered events stay inbound-only.
- `disconnectConnection` deletes the connection's active triggers and their derived timers, and puts `cancelledTriggers` in the `system.app.disconnected` payload (the catalog schema allows it).
- `updateProfile` recomputes active cron schedules' `next_fire_at` on a time-zone change (`rescheduleCron` in `@winston/db/profile`).
- Teaching Winston what to do with `cancelledTriggers` is left to fa537d, the prompt ticket.
- Tests: connections (scoped cancel and timers), profile (New York to London reschedule; always-delivered bypass), matching (a site event fires a subscription through the job).

