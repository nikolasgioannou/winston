---
id: "6abd88"
title: Add winston task list, get, cancel and resume
status: done
priority: none
labels:
  - agents
  - cli
  - m6
created_at: 2026-09-27T05:38:49.938Z
updated_at: 2026-10-01T17:55:17.377Z
blocked_by:
  - "1fd02f"
  - "fe870e"
---

The front of house needs to answer "what are you working on?", cancel tasks, and resume parked ones (docs/design.md §11 `winston task`). Background agents can inspect tasks too.

VM API routes and CLI commands:
- **`task list [--status running|parked|done|failed|all] [--since]`:** the default is running plus parked. One line each: id, status, age, step count, and the first line of the brief.
- **`task get <task_id>`:** the brief, trigger, status, step count, result, and (when parked) the reason and handoff link.
- **`task cancel <task_id>`:** a running task stops **at its next step boundary**, never mid-tool-call, and a parked task is finalized. Either way it ends `cancelled`, with a short report of what it had done, delivered as a `task.completed` item marked as cancelled.
- **`task resume <task_id> [--note <text>]`:** only for parked tasks. The note (for example "user says done") is injected as the next input, and the run continues from its checkpoint. This is how the front of house routes the user's "done" (§1 Browser handoff).
- Register `task_` with the `winston get` resolver.

Tests: cancel at a step boundary (with the fake model), cancelling a parked task, resuming with a note injecting it, resuming a non-parked task failing with a clear error, and output snapshots.

## As built

- Routes in `packages/vm-api/src/tasks.ts`, CLI in `apps/cli/src/resources/task.ts`, and the run-level operations in `@winston/db/tasks` (`finishTask`, `cancelTask`, `resumeTask`, `queueTaskStep`), moved out of `apps/agents` so the gateway's VM-facing API can use them too.
- Cancelling a running task: `runs.cancel_requested_at`, honored at the next step boundary with a final no-tools report call; a cancel during a model call stops its tools from starting. Details in docs/design.md §11.
- Resume works on any parked run; nothing parks yet (ac0f5f adds parking). Resuming answers the parked tool call with the note.

