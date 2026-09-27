---
id: "2dd479"
title: Define the VmProvider interface with a Docker implementation
status: todo
priority: none
labels:
  - backend
  - m2
  - vm
created_at: 2026-09-27T05:32:51.223Z
updated_at: 2026-09-27T05:32:51.272Z
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
