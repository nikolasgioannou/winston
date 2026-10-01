---
id: "071e49"
title: Build the services stack on ECS Fargate
status: todo
priority: none
labels:
  - infra
  - m4
created_at: 2026-09-27T05:36:32.678Z
updated_at: 2026-09-27T05:36:32.782Z
blocked_by:
  - "2a17a6"
  - "2ca5a6"
  - "78c130"
  - "f25d3b"
  - "f92c63"
---

This stack runs the four services (docs/design.md §9, §19).

Research ECS Fargate details before writing it:
- Task sizing for small Bun services, and ARM64 (Graviton) vs x86, since it's cheaper if the images and dependencies support it.
- Rolling deployments with the deployment circuit breaker and automatic rollback.
- ALB host-based routing, websocket support and idle timeouts on the ALB (gateway holds long-lived websockets, so the idle timeout and keepalives must be set so connections aren't cut every 60 s).
- How `agents` reaches `gateway`'s **internal** API privately: ECS Service Connect / Cloud Map, or an internal ALB listener. The design says security groups restrict it. Pick the simplest private option.

Build:
- ECR repositories, and an ECS cluster.
- Task definitions with per-service secrets, IAM task roles following least privilege (KMS decrypt only where needed, S3 access scoped per bucket), log groups with retention, and health checks.
- Services in the public subnets with public IPs.
- **Database credentials** (decided in the data stack, docs/design.md §12a): services get the database host and the RDS-managed secret's ARN, not a password. `@winston/db`'s client passes postgres.js a `password` function that reads the secret's current value for each new connection, so rotation never needs a restart. Connect with TLS (verify against the RDS CA bundle). Grant each task role `secretsmanager:GetSecretValue` on that secret only.
- An ALB with a certificate:
  - `api.runwinston.com` → `api`.
  - `gateway.runwinston.com` → `gateway`, for VM websockets only. Its internal API is *not* routed publicly.
  - `web` behind CloudFront, in the next ticket.

Record the chosen sizes and expected monthly cost in §19. Stack tests: no service is publicly reachable except through the ALB, the gateway internal API isn't exposed on the ALB, and the circuit breaker is enabled.

- Output the load balancer's DNS name, and have the founder add the `api` and `gateway` CNAMEs in Cloudflare (DNS only), following docs/runbooks/dns.md. Use the Edge stack's certificate.
