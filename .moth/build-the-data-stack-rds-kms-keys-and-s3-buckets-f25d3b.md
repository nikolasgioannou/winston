---
id: "f25d3b"
title: "Build the data stack: RDS, KMS keys and S3 buckets"
status: todo
priority: none
labels:
  - db
  - infra
  - m4
created_at: 2026-09-27T05:36:32.394Z
updated_at: 2026-09-27T05:36:32.427Z
blocked_by:
  - "2a17a6"
---

Stateful resources live in their own stack, with deletion protection (docs/design.md §12, §12a, §19).
- **RDS Postgres:** the same major version as local. Single-AZ `db.t4g.micro` to start, in the isolated subnets. Encrypted, automated backups on, deletion protection on, `RETAIN` removal policy. The **master credentials are managed by RDS in Secrets Manager with rotation**. Research how services should pick up rotated credentials without restarts or outages.
- **KMS keys:**
  - One for connection tokens (envelope encryption, used by the vault).
  - One **asymmetric** key for signing VM binaries (§12a).
  - Key policies granting decrypt only to the roles that need it: `api` and `agents` for tokens, CI for signing.
- **S3 buckets:**
  - `artifacts`: VM binaries and their signatures, read by VMs.
  - `blobs`: screenshots and attachments referenced from the model-call log (§12).
  - Both block public access and are encrypted. Add lifecycle rules where sensible.

Stack tests: deletion protection and retain policies are set, buckets block public access, and key policies don't grant broad access.
