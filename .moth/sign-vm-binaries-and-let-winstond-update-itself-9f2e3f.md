---
id: "9f2e3f"
title: Sign VM binaries and let winstond update itself
status: todo
priority: none
labels:
  - infra
  - m4
  - vm
created_at: 2026-09-27T05:36:33.051Z
updated_at: 2026-09-27T05:36:33.103Z
blocked_by:
  - "245cbb"
  - "f25d3b"
---

The CLI changes constantly, since every new capability is a CLI command, so VMs update in place within seconds of a deploy, with no downtime (docs/design.md §10, Updates happen in place).

Build the pipeline pieces:
- **Signing:** a script CI will call that signs each binary's hash with the **asymmetric KMS key**. CI never sees the private key. It uploads the binary and signature to the `artifacts` bucket under its version, and updates a `latest` manifest. Research KMS `Sign`/`Verify` with ECC or RSA keys, and pick an algorithm with fast offline verification.
- **Public key:** baked into the image, so `winstond` can verify offline.
- **Announcement:** when the backend starts (or on deploy), `gateway` knows the current CLI and `winstond` versions from the manifest, and sends `update.available` to connected VMs whose `hello` reported older versions.
- **In `winstond`:** download from S3 (the instance profile allows reads), verify the hash and signature, swap binaries **atomically** (write to a temp file, rename), then restart itself via systemd for its own binary. The CLI binary just gets replaced. Never install an unverified binary. Keep the previous version to roll back to if the new `winstond` fails to connect.
- **Version handshake:** until a VM reports the current CLI version, `gateway` holds back new agent `exec` work for it (§10). The system prompt and CLI `--help` must always agree. Keep the hold short. If the update fails, alert through logs and let work proceed on the old version rather than wedging the user.

Tests: signature verification rejects a tampered binary, the atomic swap, rollback on failed restart, and the gateway's hold-then-release behaviour.
