---
id: "e1a361"
title: Deploy to production on every push to main
status: done
priority: none
labels:
  - infra
  - m4
  - tooling
created_at: 2026-09-27T05:36:33.170Z
updated_at: 2026-10-01T08:12:23.821Z
blocked_by:
  - "021c52"
  - "071e49"
  - "45b4ce"
  - "8203ff"
  - "9f2e3f"
---

From here on, every push to `main` ships to production (docs/design.md §8b). Extend the existing CI workflow, so deploy runs only after the checks pass:
1. The checks, as today. A failure stops everything.
2. Build the four images, tagged with the git SHA, and push them to ECR. Use layer caching, so this isn't slow.
3. Run database migrations as a **one-off ECS task** using the new image. If migrations fail, stop, and leave the old version running.
4. Update the ECS services with rolling deploys and automatic rollback on failed health checks. Wait for stability.
5. Build, sign and publish the CLI and `winstond` binaries, and update the manifest. VMs self-update.
6. `cdk deploy` when files under `infra/` changed (path filter), before the service updates when it matters. Think through the ordering, since a new service version might depend on new infra.

Handle concurrency: two quick pushes must not deploy interleaved. Use GitHub's `concurrency` group so a newer run waits, or cancels the older one before its deploy phase.

Write `docs/runbooks/deploys.md`: how to watch a deploy, how to roll back (redeploy a previous SHA), and what to do if migrations fail halfway. Verify with a harmless change that flows all the way to production.

**Done (2026-10-01):** `cdk deploy --all` runs on every deploy rather than behind a path filter (unchanged stacks are skipped, and an infrastructure change can't be forgotten). Images build on native ARM64 runners. Migrations run on the new ops image through a re-registered task revision.
