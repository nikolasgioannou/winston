---
id: "60490f"
title: Create the CDK app skeleton
status: done
priority: none
labels:
  - infra
  - m4
  - tooling
created_at: 2026-09-27T05:36:32.279Z
updated_at: 2026-10-01T03:20:27.179Z
blocked_by:
  - "2c0dbe"
  - "51d785"
---

All static infrastructure is AWS CDK in TypeScript, run with Bun (docs/design.md §8, §19).

Research CDK thoroughly before structuring the app:
- Current CDK v2 practices: stack organization, cross-stack references vs SSM parameters, `cdk.context.json`, removal policies (production data must never be deleted by accident), `cdk bootstrap`, and `cdk diff` in reviews.
- Running the CDK app with Bun (`bunx cdk`, `app: "bun run bin/app.ts"`), including any known incompatibilities.
- How to unit-test stacks with `aws-cdk-lib/assertions`.

Set up `infra/`:
- `bin/app.ts` defining the stacks from §19 as empty shells: Network, Data, Services, Edge, Vm, Ci, Budget.
- Environment config for account, region `us-east-1` and domain.
- Root scripts `infra:synth`, `infra:diff`, `infra:deploy`.
- Bootstrap the `winston-prod` account.

Add a synth test that runs in the normal test suite, so broken infra code fails the pre-commit hook. `cdk synth` passing and `cdk bootstrap` done are the finish line. No real resources yet.
