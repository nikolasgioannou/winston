---
id: "0a3197"
title: Sites can run up an unbounded bill
status: done
priority: none
labels:
  - backend
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.292Z
updated_at: 2026-10-04T06:28:44.205Z
blocked_by:
  - "28a208"
---

Usage, caps and costs (parent's spec, Guardrails).

**What to build**
- An hourly job that reads each site's requests and CPU time (research the Workers analytics API per script) and D1 usage, and writes `cost_ledger` rows under a new hosting category; `bun run costs` shows it.
- A monthly request cap per site, a database size cap, and a monthly hosting cap per user. Going over pauses the site (the dispatch Worker's "paused" page) and tells Winston, who tells the user. Sites unpause at the start of the next month or when raised by hand.
- A global kill switch that pauses every site at once (a `bun run prod` command), documented in the runbook.

**Done when**
- [x] Hosting spend shows per user in `bun run costs`
- [x] A site over its cap is paused and the user hears about it once
- [x] The kill switch pauses and resumes every site

## As built

- `@winston/site-host/usage` (`accrueSiteUsage`, `pauseSite`, `resumeSite`, the kill switch) and the hourly job in `apps/agents/src/sites/usage-job.ts`. Usage is charged under a new `hosting` category, at Workers for Platforms' prices past what the plan includes, so each user's share (docs/design.md §9a "Guardrails").
- **Caps:** 1M requests a month per site, $10 a month of hosting per user, 500 MB per database. CPU and subrequests per request were already capped by the dispatch Worker. Month-long pauses lift on the 1st; a database pause lifts when it's back under the cap.
- **Telling Winston:** a new always-delivered system event, `system.site.paused` (site, name, reason, `resumesAt`), recorded once per site, month and reason, with a line in the front-of-house prompt (d35258). **This adds an event type to the §3 catalog, flagged for the founder** since event names are an invariant; no existing event changed.
- **Usage source:** `SiteHost.usage` and `databaseSize`. D1 refuses `PRAGMA`s, so the size comes from `meta.size_after`, which every query result carries. Locally, the `sites` service's public port became a counting proxy in front of Miniflare, since there's no analytics there (CPU is 0 locally).
- **Kill switch:** `bun run sites:switch pause-all|resume-all` locally; checked on the dev stack (a paused site answered 503, and 303 once resumed). The `bun run prod` command moved to d140ab with the Cloudflare host.
- Charges that round to $0.000000 aren't written, so quiet hours don't fill the ledger.
