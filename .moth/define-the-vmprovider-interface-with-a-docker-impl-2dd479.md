---
id: "2dd479"
title: Define the VmProvider interface with a Docker implementation
status: done
priority: none
labels:
  - backend
  - m2
  - vm
created_at: 2026-09-27T05:32:51.223Z
updated_at: 2026-09-27T23:54:42.682Z
blocked_by:
  - "03156b"
  - "ea07c8"
---

Provisioning goes through a `VmProvider` interface with two implementations: Docker locally, EC2 in production (docs/design.md §8a). This ticket defines the interface and the Docker implementation. EC2 comes in M4.

Interface, roughly:
- `create({ userId, registrationToken }) → { instanceId, dataVolumeId }`
- `start`, `stop`, `destroy`
- `status(instanceId)`

Keep it small and async, and shape it so EC2's realities (a separate data volume, launch taking a minute or two) fit without changes.

Docker implementation:
- Research talking to the Docker Engine API from Bun: the unix socket directly, vs shelling out to `docker`. Prefer the API for structured results if it's straightforward.
- Run the local image with the flags decided in the systemd spike.
- A named Docker volume per user mounted at `/home/winston`, standing in for the EBS data volume, so destroying and recreating a container keeps notes and files.
- Pass the registration token and gateway URL as environment variables.

Add a `provision_vm` job handler that creates a registration token (stores only its hash), calls the provider, and advances the VM state. The account-creation flow in M3 will enqueue it. For now a script can.

Tests: the Docker provider behind a thin adapter, unit-tested with the Docker calls stubbed. Plus one real integration test, skipped when Docker isn't available, that creates, starts and destroys a container.

## Outcome

Built as described in docs/design.md §8a (`VmProvider` and the Docker implementation).
- **Docker access:** the Engine API over its unix socket (Bun's `fetch({ unix })`), rather than shelling out to `docker`.
- **Tokens:** `createVm` no longer issues a token. `issueRegistrationToken` rotates one for each provisioning attempt, since the raw token is never stored.
- **Job:** `provision_vm` is shared as `provisionVmJob` in `@winston/domain/jobs`. `bun run vm:provision` queues it for the seeded user.
- **Tests:** unit tests stub the Engine API. One real integration test creates, starts, stops and destroys a container, skipped when Docker or the image isn't available (as in CI).
- **Manual check:** through `bun dev` the seeded user's VM came up: `registering`, container running, systemd `running`, volume at `/home/winston`, token and gateway URL in systemd's environment. The first attempt failed because the dev database lacked the new migration (`bun dev` migrates only at startup), and the job exhausted its retries. A re-queue after `bun run db:migrate` worked.
- **Notes for later tickets:** `PassEnvironment=` for the winstond unit, and the gateway's default port 3001 plus the registration timeout for the gateway ticket.
