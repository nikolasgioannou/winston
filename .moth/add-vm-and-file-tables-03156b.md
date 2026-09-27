---
id: "03156b"
title: Add VM and file tables
status: todo
priority: none
labels:
  - db
  - m2
created_at: 2026-09-27T05:32:51.174Z
updated_at: 2026-09-27T05:32:51.207Z
blocked_by:
  - "762cf0"
---

Add `vms` and `files` to the schema (docs/design.md §14).

`vms` has one row per user:
- `provider`: `docker` | `ec2`.
- `instance_id`: the container or instance.
- `data_volume_id`.
- `state`: the VM state machine from §17, `requested → provisioning → registering → ready`, plus `unhealthy`, `updating`, `failed`, `terminating`, `terminated`.
- `token_hash` for the long-lived VM token, and `registration_token_hash` for the one-time bootstrap token (§15).
- The versions `winstond` reports (`cli_version`, `winstond_version`), and `last_seen_at`.

Encode the state machine's legal transitions in code next to the schema: a `transition(vm, event)` function that throws on illegal moves. Several services will change VM state, and they need one source of truth.

`files` records attachments that land on the VM: `vm_path`, `mime`, `size` and `telegram_file_id`.

Tests: every legal transition succeeds, every illegal one throws, and tokens are only ever stored hashed. Add a helper for hashing and comparing tokens in constant time, and use it.
