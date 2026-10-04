---
id: "d140ab"
title: Sites aren't live in production
status: todo
priority: none
labels:
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:59:05.230Z
updated_at: 2026-10-04T06:28:44.154Z
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

- `SITES_PASS_KEY` for `web` in Secrets Manager (and the CDK task definition), `SITES_PUBLIC_URL=https://runwinston.app`; the dispatch Worker gets the public half (`sitePassPublicKey`) and `WEB_PUBLIC_URL` as plain vars.

- [ ] The backend's token, read from Secrets Manager, can list the `winston-sites` namespace's scripts (moved from f432a3). Both tokens go in through `bun run prod:keys` with hidden input, like the other external keys.

- The Cloudflare `SiteHost`'s `usage` (Workers analytics GraphQL, per script in the dispatch namespace; check the dataset and its dimensions) and `databaseSize` (`meta.size_after` from a query, or the database's info). `bun run prod sites pause-all|resume-all` for the kill switch.
