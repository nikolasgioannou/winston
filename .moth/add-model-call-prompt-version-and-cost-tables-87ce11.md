---
id: "87ce11"
title: Add model-call, prompt-version and cost tables
status: done
priority: none
labels:
  - db
  - m1
created_at: 2026-09-27T05:30:54.094Z
updated_at: 2026-09-27T18:45:48.789Z
blocked_by:
  - "c5850d"
---

"The database is the record" is an invariant: any agent run must be reconstructable from Postgres alone, including silent turns (docs/design.md §12). This ticket adds the tables for it: `model_calls`, `prompt_versions` and `cost_ledger` (§14).

- **`model_calls`:** one row per call, with the model, provider, `prompt_hash` (a foreign key to `prompt_versions`), the `run_messages` id range that formed the context, every token count (input, cached, cache write, output, reasoning), `cost_usd` (exact numeric), latency and stop reason. It doesn't store the rendered request, which can be rebuilt, or the messages, which live in `run_messages`. Calls are deleted with their run.
- **`prompt_versions`:** content-addressed. The hash is the primary key, and the text is stored once.
- **`cost_ledger`:** one row per charge, with a `category` enum (today only `model`; Jev, transcription and VM categories arrive with their tickets). Rows outlive their run (`run_id` is set null), so spend history is never lost.

The cost-summary query helper is left to the cost-reporting ticket (M9) that uses it.

Tests:
- A call is recorded against a stored prompt version.
- An unknown prompt hash is rejected.
- Calls cascade with their run.
- Costs sum exactly, and survive their run's deletion.
- An unknown category is rejected.
- All migrations apply to a fresh test database.
