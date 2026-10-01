---
id: "dd8241"
title: Add budget alerts and model spend limits
status: done
priority: none
labels:
  - infra
  - m4
created_at: 2026-09-27T05:36:33.293Z
updated_at: 2026-10-01T15:57:06.404Z
blocked_by:
  - "60490f"
---

The founder wants to know if spending goes abnormal (docs/design.md §8, Account isolation). The one-user baseline is about $120/month, so AWS Budgets alerts are set at **$150 actual** and **$200 forecast** per month for `winston-prod`, emailed to the founder. Build this in the Budget stack. Research AWS Budgets notification types (actual vs forecasted, thresholds) and how to set the email recipient without committing it: the founder's email shouldn't be in the public repo, so read it from context or a parameter at deploy time.

Model spend isn't billed by AWS at all, since it goes to OpenRouter. Walk the founder through setting an **OpenRouter credit limit and low-balance alert** on their account, and write the steps into `docs/runbooks/costs.md`. Do the same for TypeSafe if Jev has billing controls.

Stack test: both alerts exist with the right thresholds.

**Done (2026-10-01):** deployed, alerting `/winston/alert-email` (set to the founder's AWS address). The OpenRouter steps are in docs/runbooks/costs.md for the founder to apply on their account; Jev isn't wired yet, so its controls wait for M8.
