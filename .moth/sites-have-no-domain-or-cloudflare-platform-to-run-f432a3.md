---
id: "f432a3"
title: Sites have no domain or Cloudflare platform to run on
status: done
priority: none
labels:
  - collab
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:55:06.982Z
updated_at: 2026-10-04T05:06:35.860Z
---

Done with the founder: these steps need their accounts.

**What to do**
- Buy `runwinston.app` in Cloudflare Registrar, in the Winston Cloudflare account (`docs/runbooks/dns.md`).
- Turn on Workers Paid and Workers for Platforms ($25/mo), and create the dispatch namespace.
- Create a Cloudflare API token scoped to what the backend needs (Workers scripts in the namespace, D1, Workers KV, analytics read) and store it in Secrets Manager (§12a).
- A Cloudflare billing alert.
- A runbook, `docs/runbooks/sites.md`, recording all of this.

**Done when**
- [x] `runwinston.app` is registered and on Cloudflare DNS
- [ ] The namespace exists and the token can list its scripts, from the backend's secret
- [x] The billing alert is set and the runbook says how all of this was set up

## As built

Done by the founder in the dashboard on 2026-10-04 and recorded in `docs/runbooks/sites.md`: the domain, the plan, the `winston-sites` namespace (created in the dashboard), the `winston-site-routes` KV namespace, the `*` record, both tokens and a $40 budget alert.

The tokens use the legacy Workers Scripts permission, because the new Workers roles don't document dispatch namespaces yet. They sit in the founder's password manager: putting them in Secrets Manager and checking the backend's token against the namespace moved to d140ab, which builds the code that reads them.
