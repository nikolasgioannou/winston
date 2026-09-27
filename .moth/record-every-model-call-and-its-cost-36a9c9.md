---
id: "36a9c9"
title: Record every model call and its cost
status: done
priority: none
labels:
  - agents
  - db
  - m1
created_at: 2026-09-27T05:30:54.691Z
updated_at: 2026-09-27T20:38:09.339Z
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

## Outcome

Built as described in docs/design.md §12 ("How recording works").
- **Can't be forgotten:** the gateway now exposes only `generate({ profile, run, … })`, which records every step through a sink before the caller's `onStepEnd`.
- **Sink:** `dbModelCallSink` writes `model_calls` plus `cost_ledger` in one transaction and never throws. It logs the full record on failure. I decided against a retry buffer, since the log line keeps the data.
- **Cost:** OpenRouter's reported cost is preferred. `pricing.ts` is the fallback and flags drift above 5%.
- **Pricing table:** it only holds the 5-minute cache-write rate, the one TTL in use. The 1-hour rate joins when something uses 1-hour caching.
- **Verification:** the price table was checked against real smoke-test charges, and those cases are the pricing tests.
- **Test helpers:** `fakeGateway` (a scripted fake OpenRouter transport) and `testRun` live in `apps/agents/src/model/testing.ts` for the turn tickets.
