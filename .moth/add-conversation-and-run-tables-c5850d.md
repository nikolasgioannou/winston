---
id: "c5850d"
title: Add conversation and run tables
status: todo
priority: none
labels:
  - db
  - m1
created_at: 2026-09-27T05:30:54.047Z
updated_at: 2026-09-27T05:30:54.078Z
blocked_by:
  - "762cf0"
---

These tables are the backbone of the agent system: what arrives (`inbound_items`), what Winston sends (`outbound_messages`), each agent run (`runs`), and the append-only message log that doubles as the checkpoint (`run_messages`). Also `front_state`, the FIFO pointer for the front of house. Columns are sketched in docs/design.md §14. Treat that as a starting point and adjust if something better emerges, updating the doc in the same commit.

Things to get right, because a lot builds on them:
- `inbound_items.payload` holds **structured** data, never rendered XML. Envelopes are rendered at read time (invariant, §4). Include `consumed_by_run_id`, so a front-of-house turn knows which items it has handled.
- `run_messages` is **append-only** with a per-run `seq`, and stores AI SDK `ModelMessage` JSON. Add a `kind` column now (`message` | `compaction`), even though compaction arrives in M6, so the table's meaning doesn't change later.
- The front of house's messages across turns need to read as one continuous stream per user, for the rolling window. Decide how: for example a per-user monotonically increasing sequence, or querying across the user's `front` runs ordered by (run, seq). Record the choice in §14.
- `runs.status` and `trigger_type` as enums matching §17, so exhaustive `switch`es work.
- Full-text search columns (`tsv`) can wait for M9's history search. Don't add them now.

Tests: inserting and reading back a run with messages in order, and the enum constraints rejecting unknown values.
