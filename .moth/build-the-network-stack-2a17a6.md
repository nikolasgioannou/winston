---
id: "2a17a6"
title: Build the network stack
status: todo
priority: none
labels:
  - infra
  - m4
created_at: 2026-09-27T05:36:32.345Z
updated_at: 2026-09-27T05:36:32.378Z
blocked_by:
  - "60490f"
---

The network is deliberately simple and NAT-free (docs/design.md §8, §10, §19):
- A VPC across 2 availability zones.
- **Public subnets** for Fargate tasks and user VMs. Both get public IPs and reach the internet directly, which avoids a NAT gateway's ~$32/month base fee plus per-GB charges.
- **Isolated subnets** (no internet route) for RDS.

Define the security groups other stacks will use, with the rules as tight as the design allows:
- **ALB:** 443 from anywhere.
- **Services:** only from the ALB, plus `agents` → `gateway` on the internal API port.
- **RDS:** only from the service security groups.
- **User VMs:** **zero inbound rules**. `winstond` only connects out.

Research whether VPC endpoints for S3, and for Secrets Manager and KMS, are worth it without a NAT gateway. S3 gateway endpoints are free. Interface endpoints cost money. Decide and note it in §19.

Stack tests assert the important properties: no NAT gateway, the VM security group has no ingress, and RDS isn't publicly accessible.
