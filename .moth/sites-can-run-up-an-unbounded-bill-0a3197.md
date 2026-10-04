---
id: "0a3197"
title: Sites can run up an unbounded bill
status: todo
priority: none
labels:
  - backend
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.292Z
updated_at: 2026-10-04T02:59:13.513Z
blocked_by:
  - "28a208"
---

Usage, caps and costs (parent's spec, Guardrails).

**What to build**
- An hourly job that reads each site's requests and CPU time (research the Workers analytics API per script) and D1 usage, and writes `cost_ledger` rows under a new hosting category; `bun run costs` shows it.
- A monthly request cap per site, a database size cap, and a monthly hosting cap per user. Going over pauses the site (the dispatch Worker's "paused" page) and tells Winston, who tells the user. Sites unpause at the start of the next month or when raised by hand.
- A global kill switch that pauses every site at once (a `bun run prod` command), documented in the runbook.

**Done when**
- [ ] Hosting spend shows per user in `bun run costs`
- [ ] A site over its cap is paused and the user hears about it once
- [ ] The kill switch pauses and resumes every site
