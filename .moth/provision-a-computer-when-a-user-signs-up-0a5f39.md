---
id: "0a5f39"
title: Provision a computer when a user signs up
status: todo
priority: none
labels:
  - backend
  - m3
  - vm
created_at: 2026-09-27T05:34:40.668Z
updated_at: 2026-09-27T05:34:40.716Z
blocked_by:
  - "244f55"
  - "2dd479"
---

Signing up provisions the user's own VM (product.md §1). On first sign-in, in the same transaction that creates the user, create a `vms` row in `requested` and enqueue `provision_vm`. The job exists from M2. Make sure it's idempotent, since a retried job must not create two machines.

Expose the VM's state to the web app through a server function, so `/home` can show "setting up your computer…", "ready" or "something went wrong." Decide how the page stays fresh while provisioning: polling a server function is simplest and fine at this scale. On `failed`, retry automatically a limited number of times, then show the failure state with a retry action.

Retire the M1 dev-seed dependency for the VM part: a fresh local sign-up should provision a local Docker VM through the same path production will use. Keep the seed script for tests and quick resets. Update `docs/local-dev.md`.

Tests: sign-up creates exactly one VM row and one job, job retries don't double-provision, and state transitions follow the state machine.
