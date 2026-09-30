---
id: "0a5f39"
title: Provision a computer when a user signs up
status: done
priority: none
labels:
  - backend
  - m3
  - vm
created_at: 2026-09-27T05:34:40.668Z
updated_at: 2026-09-30T03:09:38.601Z
blocked_by:
  - "244f55"
  - "2dd479"
---

Signing up provisions the user's own VM (product.md §1). On first sign-in, in the same transaction that creates the user, create a `vms` row in `requested` and enqueue `provision_vm`. The job exists from M2. Make sure it's idempotent, since a retried job must not create two machines.

Expose the VM's state to the web app through a server function, so `/home` can show "setting up your computer…", "ready" or "something went wrong." Decide how the page stays fresh while provisioning: polling a server function is simplest and fine at this scale. On `failed`, retry automatically a limited number of times, then show the failure state with a retry action.

Retire the M1 dev-seed dependency for the VM part: a fresh local sign-up should provision a local Docker VM through the same path production will use. Keep the seed script for tests and quick resets. Update `docs/local-dev.md`.

Tests: sign-up creates exactly one VM row and one job, job retries don't double-provision, and state transitions follow the state machine.

## Outcome

- `requestVm` (`@winston/db/vms`) inserts the `vms` row in `requested` and queues `provision_vm` in one transaction, only when the user has none. Sign-in calls it in the same transaction that creates or first links the user, so sign-up, pre-existing users and the dev seed all take the same path. `vms.provider` is now null until provisioning records the provider it used.
- Failures: `provision_vm` gets 3 attempts; when the last fails, or the gateway sweeper finds setup stuck for 10 minutes, `failVmSetup` applies the renamed `setup_failed` event (was `timed_out`), counts it in a new `vms.setup_failures` and queues an automatic retry after 30 s × the count, up to 3 times in a row. Reaching `ready` resets the count. `retryFailedVm` is the manual retry.
- The web app gets `getComputerStatus` (`setting_up`, `ready`, `unreachable`, `failed`; a failed VM with a retry queued counts as setting up) and `retryComputer` server functions, behind a new `requireUser`. Freshness: `/home` polls `getComputerStatus` while setting up (built in the home page ticket).
- `bun dev`'s `vm` task and `vm:provision` use `requestVm`/`retryFailedVm`; the seed requests the seeded user's VM. docs/local-dev.md and design.md §8a, §15, §17 and the schema table are updated.
- Tests: sign-up creates exactly one VM row and one job (and signing in again adds neither), linking the seeded user requests one, the job's early failures leave the VM provisioning while the last fails it and queues a retry, automatic retries are limited with growing waits, the count resets on ready, status follows the state machine, and the sweeper queues a retry.
- Checked live against `bun dev`: a new user's `requestVm` gave a local Docker VM that reached `ready` with provider `docker` (the throwaway user, container and volume were removed afterwards).

