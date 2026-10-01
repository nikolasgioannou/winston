---
id: "f92c63"
title: Set up DNS and certificates for runwinston.com (with the founder)
status: done
priority: none
labels:
  - collab
  - infra
  - m4
created_at: 2026-09-27T05:36:32.443Z
updated_at: 2026-10-01T04:31:32.418Z
blocked_by:
  - "16c290"
  - "60490f"
---

**Decided by the tunnel ticket (`16c290`):** `runwinston.com` is registered with Cloudflare Registrar, and its **DNS is on Cloudflare**, not Route 53. This ticket validates ACM certificates through Cloudflare DNS records and points records at CloudFront and the ALB. It creates no Route 53 zone.

Production uses `runwinston.com` (the site and apex), `api.runwinston.com` and `gateway.runwinston.com` (docs/design.md §8, §19). Where DNS lives depends on the local-tunnel decision: the tunnel ticket may have moved the zone to Cloudflare. Read what was decided there and in §8a before starting.

If DNS stays in Route 53:
- Create the hosted zone in the Edge stack.
- Have the founder point the domain's nameservers at it, at their registrar.
- Issue ACM certificates with DNS validation: one in `us-east-1` for CloudFront (which requires it) and for the ALB in the same region.

If DNS lives in Cloudflare:
- Validate ACM certificates through Cloudflare records (manually or via Terraform), and document how CDK-created endpoints get their records.

Either way, the outcome is certificates issued and a documented, reproducible way for later stacks to create DNS records. Write the steps into `docs/runbooks/dns.md`. Verify with `dig` that the delegation or records resolve.

**Done (2026-10-01):** one ACM certificate for the apex, `api.` and `gateway.` in the Edge stack, validated by CNAMEs the founder added in Cloudflare (DNS only). Later records are added by hand from the table in docs/runbooks/dns.md (the founder's choice over a Cloudflare API script).
