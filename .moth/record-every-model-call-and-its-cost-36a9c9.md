---
id: "36a9c9"
title: Record every model call and its cost
status: todo
priority: none
labels:
  - agents
  - db
  - m1
created_at: 2026-09-27T05:30:54.691Z
updated_at: 2026-09-27T05:30:54.737Z
blocked_by:
  - "0bfb79"
  - "87ce11"
---

The model-call log is how anything Winston did gets reconstructed later. It's the only "observability" we have (docs/design.md §12). Wire the model gateway so every call writes a `model_calls` row and a `cost_ledger` row automatically. Callers must not be able to forget.

Needs:
- A pricing table per model: input, output, cache read and cache write rates (5-minute vs 1-hour writes differ). Take the current OpenRouter rates from docs/research/models-openrouter.md, and keep them in one typed file that's easy to update. If OpenRouter returns the actual charged cost in its response metadata, prefer that and fall back to computing.
- The row captures run id, step, model, provider (confirm it really was Anthropic, since that's what pinning is for), `prompt_hash`, the `run_messages` seq range that formed the context, all token counts, cost, latency and stop reason.
- Logging failures (the DB is down) must not crash an otherwise successful turn. Log loudly and continue. Decide whether to buffer and retry.

Tests: cost computation for each model with cache reads and writes, and that a gateway call with a fake transport writes exactly one row of each kind.
