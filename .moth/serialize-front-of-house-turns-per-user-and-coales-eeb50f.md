---
id: "eeb50f"
title: Serialize front-of-house turns per user and coalesce bursts
status: todo
priority: none
labels:
  - agents
  - m1
created_at: 2026-09-27T05:30:54.948Z
updated_at: 2026-09-27T05:30:54.978Z
blocked_by:
  - "cb9674"
---

Winston must never answer message by message, and must never run two front-of-house turns for the same user at once (docs/design.md §1 and §4, Steering).

Implement:
- **Per-user serialization.** Only one `front_turn` runs per user at a time, even with several workers. Use a Postgres advisory lock keyed on the user id, held for the turn's duration, or an equivalent guarantee that survives worker crashes. Research the locking semantics (session vs transaction advisory locks, what happens to a lock when a connection drops) and pick the one that's safe with our pooled connections.
- **Idle coalescing.** When messages arrive while no turn is running, the debounce (~1–2 s after the *last* item) groups them into one turn. The queue's dedupe with "push `run_at` later" is the tool for this.
- If a turn job starts and finds another turn already running for that user, it must not drop its items. They either get picked up by the running turn (the steering ticket) or trigger another turn right after. Make sure no inbound item can be orphaned.

Tests, with the fake model and real Postgres:
- A burst of 5 messages produces 1 turn.
- Two workers racing produce 1 turn at a time.
- A message arriving just after a turn completes produces a new turn.
- No unconsumed items are left behind in any of these cases.
