---
id: "46ee9b"
title: Report per-user spend
status: todo
priority: none
labels:
  - backend
  - m9
  - tooling
created_at: 2026-09-27T05:42:36.237Z
updated_at: 2026-09-27T05:42:36.313Z
blocked_by:
  - "0e0c6c"
  - "1867ba"
  - "b782bc"
---

Per-user cost tracking is recorded from day one (docs/design.md §8, Cost tracking). Model calls, Jev and transcription already write to `cost_ledger`. This ticket fills the remaining gap and makes the data easy to read, with no UI.

- **VM cost:** an hourly job that records each running VM's instance hours and storage in `cost_ledger` (category `vm`), using a small rate table in the same place as the model pricing (instance type hourly rate, gp3 per GB-month, public IPv4).
- **Report script:** `bun run prod costs [--user <email>] [--month YYYY-MM]` (and the local equivalent). It prints spend by category, model spend broken down by agent kind (front of house vs background) and trigger type (user, delegate, event, schedule), and the top 10 most expensive runs with their briefs. This is the view that tells you whether event runs, the browser or the front of house dominate cost.
- Use the query helper added with the cost tables. Extend it rather than duplicating it.

Tests: VM cost accrual across an hour boundary, the report's grouping and totals against fixture rows.
