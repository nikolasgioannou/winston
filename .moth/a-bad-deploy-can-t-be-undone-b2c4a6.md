---
id: "b2c4a6"
title: A bad deploy can't be undone
status: backlog
priority: none
labels:
  - backend
  - cli
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.241Z
updated_at: 2026-10-04T02:55:07.241Z
blocked_by:
  - "28a208"
---

Versions and rollback (parent's spec, Versions).

**What to build**
- `winston site versions <site>` lists deploys; `winston site rollback <site> [--to <version>]` redeploys a kept bundle from S3. The database isn't rolled back; the command says so.
- Keep the last 10 versions per site; older bundles are deleted.

**Done when**
- [ ] Rolling back serves the older version, and a later deploy goes on from there
- [ ] Only the last 10 bundles are kept (tests)
