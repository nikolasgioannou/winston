---
id: "961613"
title: Provision the seeded user's local VM in bun dev
status: todo
priority: none
labels:
  - m2
  - tooling
  - vm
created_at: 2026-09-27T05:32:51.883Z
updated_at: 2026-09-27T05:32:51.932Z
blocked_by:
  - "245cbb"
  - "6bac51"
---

With the image, provider, gateway and CLI in place, `bun dev` should give the seeded user a working computer without manual steps (docs/design.md §8a).

On `bun dev` startup, after migrations:
- Ensure `gateway` runs alongside `api` and `agents`.
- If the seeded user has no VM, or its container is gone, enqueue `provision_vm`.
- If the local image is older than the image scripts or binaries, say so clearly and offer the rebuild command, rather than silently running something stale.
- Surface the VM's state in the dev output ("vm_… ready").

Also add small scripts: `bun run vm:shell` (a shell inside the user's container as `winston`, for debugging) and `bun run vm:reset` (destroy the container but keep the data volume, then re-provision).

Update `docs/local-dev.md`. Done when a clean `bun dev` leads to "ask Winston to run `ls ~` and he answers."

From the exec ticket: while developing, putting the VM on a rebuilt image has meant marking it `failed` by hand and running `bun run vm:provision`. `provision_vm` does nothing for a `ready` VM, and §17 has no path from `ready` back to `provisioning`. So `vm:reset` needs a decision: for example a `reset` event, or terminate plus a fresh VM row. Lifecycle semantics are a Part 3 invariant, so decide it with the user.
