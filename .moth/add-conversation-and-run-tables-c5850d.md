---
id: "c5850d"
title: Add conversation and run tables
status: done
priority: none
labels:
  - db
  - m1
created_at: 2026-09-27T05:30:54.047Z
updated_at: 2026-09-27T18:43:29.280Z
blocked_by:
  - "762cf0"
---

The backbone of the agent system: what arrives (`inbound_items`), what Winston sends (`outbound_messages`), each agent run (`runs`), the append-only message log that doubles as the checkpoint (`run_messages`), and `front_state`, the rolling window's pointer (docs/design.md §14).

Scoped to what M1's front-of-house turns use. Columns needed only later arrive with their tickets: background-run fields and statuses (M6), compaction's `kind` (M6), attachments (M2), full-text search (M9). Adding a column later is just a migration.

Decisions:
- `inbound_items.payload` holds **structured** data, never rendered XML (invariant, §4). `source_ref` is unique, so redeliveries are ignored, and `consumed_by_run_id` marks what a turn has handled (set null if the run is deleted).
- **The front-of-house stream is `run_messages` in `id` order.** `id` is a bigint identity that increases across all runs, so a user's turns read as one continuous stream. `front_state.window_start_message_id` points into it.
- `runs.status` is a Postgres enum (today `running` | `completed` | `failed`). `seq` is unique per run.
- New id prefixes: `run` (front-of-house runs), and `hist` for history items (inbound and outbound share it).

Also adds an `insertRun` test factory. Tests:
- A run's messages read back in order.
- Messages across a user's runs form one stream.
- A duplicate `seq` is rejected.
- An unknown status is rejected.
- Duplicate `source_ref` values are ignored.
- Deleting a run leaves its items unconsumed.
- The migrations apply cleanly to a fresh test database.
