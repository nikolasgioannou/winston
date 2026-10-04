---
id: "a2f40c"
title: Sites can't be taken down
status: done
priority: none
labels:
  - backend
  - cli
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.344Z
updated_at: 2026-10-04T06:02:15.599Z
blocked_by:
  - "28a208"
---

Lifecycle (parent's spec).

**What to build**
- `winston site delete <site>` removes the Worker, the D1 database, the KV entry and every bundle, and frees the name.
- Account deletion (`apps/agents/src/accounts/delete-user.ts`) does the same for every site the user has, safe to retry like its other steps.

**Done when**
- [x] A deleted site's address shows "no site here" and its name can be claimed again
- [x] Deleting an account leaves nothing of its sites in Cloudflare, S3 or Postgres (tests against the local host)

## As built

- `winston site delete`, `DELETE /v1/sites/<site>`, and `removeSite` in `@winston/site-host/remove`, shared with account deletion. It removes the route first, so the address stops answering at once, then the Worker, the database, the row and bundles nothing else uses. Every step is safe to repeat. `SiteHost` gained `deleteDatabase`.
- Account deletion takes every site down as its step 5. `agents` gets the site host from the same `SITES_ADMIN_URL`. With sites and no host, the step fails and the job retries, so no site outlives its account.
- **Also fixed here:** §11 says every write takes `--dry-run`, and the site writes didn't. Now `deploy`, `share`, `unshare`, `rollback` and `delete` all take it, answering `{ dryRun, summary }` after the same checks as a real run (a deploy checks the bundle and the name without claiming it).
- `deleteUnusedBundles` moved into `@winston/site-host/remove`, shared with pruning.
- Tests: the route (dry run, then the real delete, then the name reused by someone else), account deletion with a fake host (and failing without one), the local host's database deletion, and dry runs for deploy and share.
