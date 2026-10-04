---
id: "a2f40c"
title: Sites can't be taken down
status: todo
priority: none
labels:
  - backend
  - cli
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.344Z
updated_at: 2026-10-04T02:59:13.564Z
blocked_by:
  - "28a208"
---

Lifecycle (parent's spec).

**What to build**
- `winston site delete <site>` removes the Worker, the D1 database, the KV entry and every bundle, and frees the name.
- Account deletion (`apps/agents/src/accounts/delete-user.ts`) does the same for every site the user has, safe to retry like its other steps.

**Done when**
- [ ] A deleted site's address shows "no site here" and its name can be claimed again
- [ ] Deleting an account leaves nothing of its sites in Cloudflare, S3 or Postgres (tests against the local host)
