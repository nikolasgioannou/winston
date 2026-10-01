---
id: "1867ba"
title: Run one-off admin commands in production
status: done
priority: none
labels:
  - infra
  - m4
  - tooling
created_at: 2026-09-27T05:36:33.433Z
updated_at: 2026-10-01T06:52:28.806Z
blocked_by:
  - "071e49"
---

Some operations need to touch production: the allowlist script, occasional investigation queries, and re-running a stuck job. There's no admin UI by design, so provide a safe way to run repo scripts against production.

Research the options: ECS one-off tasks (`aws ecs run-task` with a command override, on the same image and secrets as a service), ECS Exec into a running task, or an SSM port-forward session to RDS through a small bastion task. Prefer something that needs no long-lived bastion and no public database.

Build `bun run prod <script> [args]`: it runs a whitelisted repo script (`allowlist`, and a read-only `sql` query runner) as a one-off task using the current production image, streams the logs back, and exits with the task's status. Require an explicit confirmation for anything that writes.

Update the allowlist script's docs to cover production use. Verify by listing the production allowlist.

**Done (2026-10-01):** `bun run prod migrate | allowlist … | sql …` runs `packages/db/src/ops.ts` as a one-off task on the `ops` image; migrations use Drizzle's runtime migrator. Verified: the first production migration, `allowlist list` (empty) and a read-only count.
