---
id: "1fd02f"
title: Report background results back through the front of house
status: done
priority: none
labels:
  - agents
  - m6
created_at: 2026-09-27T05:38:49.886Z
updated_at: 2026-10-01T17:48:24.966Z
blocked_by:
  - "438b86"
---

Only the front of house messages the user (docs/design.md §4, Processing without responding, Part 3 invariant 4). When a background run ends, its outcome becomes an always-delivered inbound item, and the front of house decides whether and how to tell the user.

On run completion:
- `completed` → a `task.completed` item with the task id, the brief (short) and the report (the run's final text).
- `failed` → `task.failed` with the error summary.
- `capped` → `task.completed` flagged as capped, with the where-I-got-to summary.

Each item queues a front-of-house turn like any other input, so steering and serialization just work. Several tasks finishing close together get coalesced into one turn by the normal debounce.

Update the front-of-house prompt: task results are for Winston, not to be forwarded raw. Summarize in Winston's voice, merge related results, and stay silent if a result needs nothing from the user. That's common for event runs in M7.

Envelope rendering for these item types, with snapshot tests.

Tests with the fake model: completion produces exactly one item and one turn, failures and caps render correctly, and simultaneous completions coalesce.

## As built

- `finishBackgroundRun` ends a run and records `task.completed` / `task.failed` in one transaction; every finish path (report, cap, refusal, the job's last failed attempt) goes through it. Details and eval results in docs/design.md §4.
- Envelope: `renderTaskResult`, with inline snapshots. The front's `toEnvelopeItems` parses these items with `taskResultPayloadSchema`.
- The handler tests commit real rows (advisory locks need real connections), so they now truncate afterwards too; leftover users were colliding with other test files' generated emails on later runs.

