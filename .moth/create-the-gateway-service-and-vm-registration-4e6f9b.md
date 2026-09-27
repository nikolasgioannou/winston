---
id: "4e6f9b"
title: Create the gateway service and VM registration
status: todo
priority: none
labels:
  - backend
  - m2
  - vm
created_at: 2026-09-27T05:32:51.287Z
updated_at: 2026-09-27T17:32:16.432Z
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
