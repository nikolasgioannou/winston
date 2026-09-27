---
id: "b9062e"
title: "Build the VM stack: launch template, security and snapshots"
status: todo
priority: none
labels:
  - infra
  - m4
  - vm
created_at: 2026-09-27T05:36:32.914Z
updated_at: 2026-09-27T05:36:32.965Z
blocked_by:
  - "2a17a6"
  - "ce9145"
---

User VMs are created at runtime by the backend, not by CDK. CDK provides everything around them (docs/design.md §8, §10, §19 Vm stack).

Build:
- **Launch template:**
  - `t3a.medium`, using the latest AMI from the SSM parameter.
  - An instance profile allowing **SSM Session Manager only**, plus read access to the `artifacts` bucket for self-update. Nothing else, since VMs must hold no useful AWS permissions.
  - IMDSv2 required.
  - The zero-inbound security group, and a public IP in the public subnets.
  - A root volume of ~15 GB gp3, encrypted.
- **Data Lifecycle Manager** policy: nightly snapshots of volumes tagged as Winston data volumes, retained for a sensible window (7–14 days, decide and note it).
- **EC2 auto-recovery:** research whether the simplified automatic recovery default covers `t3a`, or whether a CloudWatch alarm with the recover action is needed, and set it up.
- An IAM policy for the backend role (`agents`, which runs `provision_vm`) scoped to launching from *this* launch template, creating and attaching tagged volumes, and terminating only tagged Winston instances.

Stack tests: the instance profile has no permissions beyond SSM and artifact reads, IMDSv2 is required, and the backend's EC2 permissions are scoped by tag and launch template.
