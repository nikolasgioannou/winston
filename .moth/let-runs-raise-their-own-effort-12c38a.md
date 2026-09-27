---
id: "12c38a"
title: Let runs raise their own effort
status: todo
priority: none
labels:
  - agents
  - cli
  - m6
created_at: 2026-09-27T05:38:50.163Z
updated_at: 2026-09-27T05:38:50.198Z
blocked_by:
  - "6abd88"
---

Effort is set by the trigger, not the model. Event-triggered runs start at `low` (most end quickly), and user delegations start at `high`. **A run can raise its own effort** when it finds real work (docs/design.md §6).

Mechanism: `winston task update [<task_id>] --effort low|medium|high|xhigh`. With no id, it applies to the current run (from `WINSTON_RUN_TOKEN`). That reuses the standard `update` verb, so there's no new concept to learn (§11 grammar). The backend stores the new effort on the run, and the next model call uses it.

The model call should use **per-message effort** (the Opus beta that avoids a cache reset, §6), if the model-gateway research confirmed it survives the AI SDK → OpenRouter path. If it didn't, fall back to changing top-level effort and accept one cache miss. Note the outcome in §6.

Update the background prompt: start light, and escalate when the task turns out to involve real work, such as multi-step replies or a browser flow.

Tests: update the current run by default, reject invalid levels, and the next model call carries the new effort. Use the fake transport to assert the request.
