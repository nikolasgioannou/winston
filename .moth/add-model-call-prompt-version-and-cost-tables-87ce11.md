---
id: "87ce11"
title: Add model-call, prompt-version and cost tables
status: todo
priority: none
labels:
  - db
  - m1
created_at: 2026-09-27T05:30:54.094Z
updated_at: 2026-09-27T05:30:54.125Z
blocked_by:
  - "c5850d"
---

"The database is the record" is an invariant: any agent run must be reconstructable from Postgres alone, including silent turns (docs/design.md §12). This ticket adds the tables for it: `model_calls`, `prompt_versions` and `cost_ledger` (§14).

Design notes:
- `model_calls` stores what the model returned and what went in: `context_from_seq`/`context_to_seq` into `run_messages`, plus `prompt_hash`. It does **not** store the rendered request, because that can be rebuilt deterministically. Include every token count the provider reports (input, cached read, cache write, output, reasoning), `cost_usd`, latency, model, provider and `stop_reason`.
- `prompt_versions` is content-addressed: the hash of the system prompt plus tool definitions is the primary key, and the text is stored once.
- `cost_ledger` rows are per charge with a `category` (`model`, `jev`, `stt`, `vm`), so later cost queries are simple sums.

Add a small query helper, even though there's no UI: "total cost for user X between two dates, grouped by category." It gets used in M9, and writing it now validates that the schema supports it. Test the helper against a few inserted rows.
