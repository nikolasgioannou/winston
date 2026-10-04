---
id: "d140ab"
title: Sites aren't live in production
status: in-progress
priority: none
labels:
  - infra
parent: "57e0e7"
created_at: 2026-10-04T02:59:05.230Z
updated_at: 2026-10-04T20:04:34.233Z
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

- The gateway gets `SITES_PASS_KEY` too, for `winston site fetch` (50922c), from the same secret as `web`; no `SITES_CONNECT_URL` in production (it fetches `https://<name>.runwinston.app` directly).

## Progress (2026-10-04): built, waiting on the founder to go live

- **Cloudflare host** (`@winston/site-host/cloudflare-host`), shaped by the current API schema and wrangler's own upload code. Covered by tests against a stub of the API:
  - assets go up through an upload session, salted per script;
  - the script `PUT` as multipart, with the module as `application/javascript+module` on the wire (checked in the raw body);
  - routes in KV, D1 `{ batch }` queries, `file_size`;
  - usage from the `workersInvocationsAdaptive` analytics dataset;
  - 404s are fine on delete.
- **One host factory** (`@winston/site-host/config`: `siteHostConfigSchema`, `siteHostFrom`) used by gateway, agents and web: Cloudflare when configured, the local host otherwise.
- **Dispatch Worker:** `apps/sites/src/dispatch/cloudflare.ts` and `apps/sites/wrangler.jsonc`, with wrangler 4.147.0 as a dev dependency. `wrangler deploy --dry-run` bundles it at 11 KB with no Node imports. `bun run sites:deploy-dispatch` reads `winston/sites-pass-key`, derives its public half and deploys. CI runs it after `bun run deploy`, skipping until `CLOUDFLARE_SITES_CI_TOKEN` is set.
- **Pass key:** now any long secret, hashed into the Ed25519 seed. CDK fills new secrets with 48 random characters, which would have failed the old 64-hex check and crashed `web`. So `winston/sites-pass-key` is generated and needs no manual step.
- **CDK:**
  - secrets `sites-pass-key` and `cloudflare-api-token`, and the Cloudflare settings as plain environment;
  - blobs read, write and delete for gateway and web (the infra tests that encoded "web never touches S3" and "the gateway only reads S3" are updated);
  - the deploy role may read just the pass key.
- **Commands:** `prod:keys` asks for the backend token. `bun run prod sites pause-all|resume-all` queues a `switch_sites` job for agents, because the ops image only has `packages/db`.
- **Docs:** `docs/runbooks/sites.md` "Going live" has the founder's steps; secrets runbook, §8, §9a and §12a are updated.
- **Still to do, with the founder:**
  - deploy;
  - `prod:keys` with the backend token;
  - `gh secret set CLOUDFLARE_SITES_CI_TOKEN`;
  - the dispatch Worker deploy;
  - the production check.
- **Then confirm two details:** the analytics CPU field name (`cpuTimeUs`), and whether D1's REST `batch` is one transaction.
