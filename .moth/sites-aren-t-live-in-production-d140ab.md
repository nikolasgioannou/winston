---
id: "d140ab"
title: Sites aren't live in production
status: todo
priority: none
labels:
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:59:05.230Z
updated_at: 2026-10-04T03:21:06.452Z
blocked_by:
  - "28a208"
  - "f432a3"
---

Everything up to deploying works on the local stack; this puts it on Cloudflare (parent's spec).

**What to build**
- The dispatch Worker deploys from the CI deploy workflow (§8b) with its own scoped token, on the `*.runwinston.app` route, with the KV namespace bound.
- The backend's Cloudflare `SiteHost` gets its token from Secrets Manager (§12a); the CDK stacks and the runbook (`docs/runbooks/sites.md`) say how.
- An end-to-end check in production with the founder: Winston deploys a site with a database, the owner opens it, a signed-out browser is refused.

**Done when**
- [ ] The dispatch Worker deploys from CI
- [ ] The production check above passes

**Carried over from 4bacc0** (needs the account to check):
- The dispatch Worker's Cloudflare entry: `env.DISPATCHER.get(script, {}, { limits })`, treating "Worker not found" as no site, and the `ROUTES` KV binding.
- The Cloudflare `SiteHost` (`@winston/site-host`): script upload with assets (upload session, then the script PUT), delete, and KV writes. Check the D1 binding's field name (`id` or `database_id`) and whether assets-only user Workers are allowed.
- [ ] A site that loops is cut off by the CPU limit and shows the "failed" page
