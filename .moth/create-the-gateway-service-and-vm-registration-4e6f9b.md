---
id: "4e6f9b"
title: Create the gateway service and VM registration
status: done
priority: none
labels:
  - backend
  - m2
  - vm
created_at: 2026-09-27T05:32:51.287Z
updated_at: 2026-09-28T00:13:46.760Z
blocked_by:
  - "03156b"
  - "2c5ac8"
  - "9378a8"
---

`gateway` is where every VM connects (docs/design.md §9 and §15). This ticket builds the service, the websocket endpoint, and the bootstrap that exchanges a one-time registration token for a long-lived VM token.

Research Bun's native WebSocket server: `Bun.serve` with `websocket` handlers, backpressure, per-connection data, pings, and max payload size. Also look at how a websocket and a normal HTTP API can coexist in one server, since gateway will also expose an internal HTTP API.

Build:
- **Registration.** A VM connects presenting its registration token. The gateway verifies the hash, issues a random VM token (stored hashed in `vms.token_hash`), burns the registration token, and moves the VM to `registering`, then `ready` once the `hello` frame arrives.
- **Normal connections.** Later connections authenticate with the VM token. Exactly one live connection per VM. A new connection replaces the old one.
- **Frames.** A typed frame protocol in `packages/shared`: `hello`, `ping`/`pong` and the frame types from §15, as a Zod-validated discriminated union with request/response correlation ids. Later tickets add frame types to it.
- **Liveness.** Update `last_seen_at` on ping. Mark a VM `unhealthy` after 2 minutes without one.
- **Internal HTTP API**, used by `agents` to reach a user's VM (exec, files, and later screencast). It's authenticated with a shared internal secret and never exposed publicly (in production, security groups restrict it). Start with `GET /internal/vms/:userId/status`.

Add `gateway` to `bun dev`.

Tests: registration succeeds exactly once per token, a bad or reused token is rejected, a replaced connection closes the old socket, frame validation rejects malformed frames. Use a test websocket client.

`provision_vm` (the VmProvider ticket) points local VMs at `ws://host.docker.internal:3001` (`VM_GATEWAY_URL`), so the gateway should listen on port 3001 by default. It also leaves VMs in `registering`, and nothing yet moves a VM that never registers to `failed` (`timed_out`). Decide where that check lives, for example here, when registration is handled.

## Outcome

Built as described in docs/design.md §15 ("Implemented").
- **Frames location:** the frames live in `@winston/domain/frames`, not `packages/shared`. Shared is business-agnostic by design, and the frames are a Winston contract.
- **Frame types:** only the types this ticket uses (`hello`, `ping`/`pong`, `registered`, `error`). Exec, files, RPC and screencast frames come with their tickets.
- **Exactly-once registration:** one conditional update both stores the VM token's hash and burns the registration token. The concurrent test shows exactly one of two racing connections gets a token, and a mutation check confirms it guards that.
- **Registration timeout (the open question):** decided here. The gateway's sweeper fails VMs stuck in setup for 10 minutes, using a new `vms.state_changed_at` column. It also handles the 2-minute ping timeout.
- **Race fix:** `provision_vm` now marks the VM `provisioned` before starting the instance.
- **Unique hashes:** `vms.token_hash` and `registration_token_hash` are unique, since they're looked up.
- **Dev setup:** `setup.sh` generates `GATEWAY_INTERNAL_SECRET` (secret generation is now one `ensure_secret` function), and `bun dev` runs the gateway.
- **Manual check:** the gateway is up in `bun dev`, the internal status endpoint works only with the secret, and the local VM container reaches the gateway at `host.docker.internal:3001`. There's no real registration yet: that needs `winstond` (next ticket). The existing local VM will time out to `failed` and can be re-provisioned then.
