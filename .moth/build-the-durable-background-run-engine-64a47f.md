---
id: "64a47f"
title: Build the durable background-run engine
status: todo
priority: none
labels:
  - agents
  - m6
created_at: 2026-09-27T05:38:49.678Z
updated_at: 2026-09-27T05:38:49.748Z
blocked_by:
  - "36a9c9"
  - "68e9cc"
  - "737b8c"
---

Background agents do the long work: browser tasks, research, multi-step chores. The engine behind them must be **durable**: checkpointed after every step, resumable by any worker, and never lost to a deploy or crash (docs/design.md §1 Implementation, §9 Durable agents, §17 Run state machine, Part 3 invariant 5).

Build the engine in `apps/agents`:
- A background run is a `runs` row (`kind: background`, `task_` id) that progresses through `run_step` jobs. The design leaves open whether one job runs the whole loop (extending its lease each step) or each step is its own job. Research the trade-off with the AI SDK's `WorkflowAgent`/`ToolLoopAgent` and our checkpointing, and pick the one where "any worker can resume any task" is simplest and most robust. Record it in §9.
- **Checkpoint:** `onStepFinish` appends the step's messages and usage to `run_messages`, and increments `step_count`.
- **Resume:** rebuild the message list from `run_messages` (later, from the last compaction row) and continue.
- **Tools:** `bash` and `view_image` (with background timeouts). `browser_handoff` comes with parking.
- **Model:** the `background` profile (Opus 5.5), with effort from the run (set by the trigger in later tickets).
- **Status transitions** through the shared state machine: `queued → running → completed | failed | cancelled | capped`.
- **Step cap:** `stopWhen: isStepCount(MAX_STEPS_PER_RUN)` (~100). A capped run ends with a short summary of where it got to, so the front of house can report honestly ("stuck at checkout, here's where I left off", §1 Only limit).
- **Transient model failures:** retry with backoff. Persistent failure puts the job back in the queue with a delay, resuming from the checkpoint (§6 Failure handling).

For now a script can start a run with a brief, since `delegate` is the next ticket but one.

Tests with the scripted fake model:
- A multi-step run checkpoints every step.
- Killing the worker mid-run and resuming continues from the last checkpoint without re-running completed steps.
- The step cap ends with a summary.
- Retries work.
