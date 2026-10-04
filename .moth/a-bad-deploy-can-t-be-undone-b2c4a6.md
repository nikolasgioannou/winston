---
id: "b2c4a6"
title: A bad deploy can't be undone
status: done
priority: none
labels:
  - backend
  - cli
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.241Z
updated_at: 2026-10-04T05:51:41.305Z
blocked_by:
  - "28a208"
---

Versions and rollback (parent's spec, Versions).

**What to build**
- `winston site versions <site>` lists deploys; `winston site rollback <site> [--to <version>]` redeploys a kept bundle from S3. The database isn't rolled back; the command says so.
- Keep the last 10 versions per site; older bundles are deleted.

**Done when**
- [x] Rolling back serves the older version, and a later deploy goes on from there
- [x] Only the last 10 bundles are kept (tests)

## As built

- `winston site versions|rollback [--to N]`, `GET /v1/sites/<site>/versions` and `POST /v1/sites/<site>/rollback` (docs/design.md §9a "Versions and rollback").
- A rollback moves `current_version` and doesn't add a version, so numbers stay stable and the next deploy is the highest plus one. It runs under the site's row lock, like a deploy.
- Pruning happens at deploy time: versions at or below `number - 10` are deleted in the deploy's transaction, and their blobs after the commit, only when no remaining version uses them (blobs are keyed by content).
- Tests: rollback to the previous and to a chosen version, the edge cases (already current, missing, nothing earlier), the next deploy's number, and keeping 10 of 12 with the oldest bundle's blob gone.
