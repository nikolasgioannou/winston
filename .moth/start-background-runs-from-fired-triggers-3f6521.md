---
id: "3f6521"
title: Start background runs from fired triggers
status: todo
priority: none
labels:
  - agents
  - events
  - m7
created_at: 2026-09-27T05:40:24.180Z
updated_at: 2026-09-27T05:40:24.234Z
blocked_by:
  - "1fd02f"
  - "88f5ee"
---

Every trigger firing (a schedule, an event batch, an expiry, a derived timer) starts the **same kind** of background run as a delegated task (docs/design.md §3 Handling, §6). This ticket builds the one function they all use.

`startTriggerRun(trigger, reason, events?)` creates a `task_` run with:
- `trigger_type`: `schedule`, `event` or `expire`, and `trigger_id`.
- **Effort `low`** by default, since most event runs end quickly and quietly (§6). The run can escalate.
- A first user message containing:
  - The trigger's **note to its future self**, or the `on_expire_note` for expiries.
  - The event envelopes, if any.
  - A **read-only conversation tail**: the last ~20 inbound and outbound items rendered, so the run knows what's going on (§16).
  - A reminder to check notes before acting on the event (§2's mitigation for "remembering to look").

Also increment `fire_count` and apply the lifecycle rules atomically with run creation, so a crash can't double-fire or lose a fire.

Results flow back like any background run (`task.completed` → front of house), and the front of house often stays silent. Double-check that path reads well for event runs: the report should say "nothing needed" crisply.

Tests with the fake model: the first message's structure for each trigger kind, the tail rendering, fire counting being atomic with run creation, and an exhausted trigger not firing again.
