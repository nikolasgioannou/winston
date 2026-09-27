---
id: "45b4ce"
title: Let GitHub Actions deploy via OIDC
status: todo
priority: none
labels:
  - infra
  - m4
created_at: 2026-09-27T05:36:33.119Z
updated_at: 2026-09-27T05:36:33.154Z
blocked_by:
  - "60490f"
---

Deploys must not rely on long-lived AWS keys stored in GitHub (docs/design.md §8b). Build the Ci stack: GitHub's OIDC identity provider in `winston-prod`, and a deploy role trusted **only** for `repo:nikolasgioannou/winston` on `refs/heads/main`.

Research the least-privilege shape for this role, given what the deploy workflow does:
- Push to ECR.
- Run the migration task and update ECS services.
- Upload artifacts and call KMS `Sign`.
- Run `cdk deploy`. This usually means assuming the CDK bootstrap roles rather than granting broad permissions directly. Understand how that works and prefer it.

Also create a separate role for the manually triggered AMI workflow with only what Packer needs.

Stack tests: the trust policy is limited to this repo and the `main` branch, and the deploy role doesn't have `*:*`. Verify with a trivial workflow step that assumes the role and runs `aws sts get-caller-identity`.
