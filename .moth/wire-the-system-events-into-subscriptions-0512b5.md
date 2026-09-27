---
id: "0512b5"
title: Wire the system events into subscriptions
status: todo
priority: none
labels:
  - events
  - m7
created_at: 2026-09-27T05:40:24.869Z
updated_at: 2026-09-27T05:40:24.943Z
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
