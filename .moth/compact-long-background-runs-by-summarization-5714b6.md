---
id: "5714b6"
title: Compact long background runs by summarization
status: done
priority: none
labels:
  - agents
  - m6
created_at: 2026-09-27T05:38:50.061Z
updated_at: 2026-10-01T18:04:28.381Z
blocked_by:
  - "64a47f"
---

Background runs are long conversations full of snapshots, screenshots and tool output. They compact by LLM summarization, like Claude Code and Codex. The front of house never does, because the user would wait (docs/design.md §2, Background-run compaction).

Implement in `prepareStep`:
- **Hygiene between compactions (no LLM):** keep only the latest ~3 screenshots in context, replacing older ones with stubs (`[screenshot, step 14, pruned]`). Tool outputs are already truncated by the bash tool. Do this in chunks, so the prefix stays cached between prunes.
- **Compaction trigger:** context above ~120k tokens.
- **Summarizer:** a separate call on the same model with a fixed compaction prompt (in `packages/prompts`). It produces a structured summary: goal and brief, progress, current page or state, what was tried and failed, key facts (ids, prices, names, URLs, file paths), and next steps.
- **Result:** a `compaction` row in `run_messages` holding the summary. The live context becomes `[brief] + [summary] + [last ~5 steps verbatim]`. Resume logic (run-core) must rebuild from the latest compaction row. The full history remains in the append-only log.
- Log the summarizer's model call like any other, with costs.

The compaction call itself must not break the "a tool call must be followed by its result" rule. Cut only at step boundaries.

Tests with the fake model: the threshold triggers exactly one compaction, the rebuilt context has the right shape, resume after compaction uses it, screenshot pruning keeps the latest 3, and tool call/result pairs are never split.

## As built

- In the step engine rather than `prepareStep`, since each step is its own job and rebuilds its context from the log (`contextOf`). Details in docs/design.md §2.
- `run_messages.kind` (`message` | `compaction`); the compaction prompt is `packages/prompts/src/compaction.md`.
- Screenshot pruning (newest 3–5, cut in chunks of three) shipped with the engine in 64a47f, because per-step jobs needed it from the start.

