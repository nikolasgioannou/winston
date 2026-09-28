---
id: "8251fd"
title: Serve the VM-facing API through winstond and gateway
status: done
priority: none
labels:
  - backend
  - m2
  - vm
created_at: 2026-09-27T05:32:51.647Z
updated_at: 2026-09-28T02:31:50.239Z
blocked_by:
  - "6dc140"
  - "737b8c"
---

This is the request path the whole CLI depends on, and it carries a security invariant: **nothing on the VM works from anywhere else** (docs/design.md §15, Part 3 invariant 1).

The path: CLI → **unix socket** `/run/winstond.sock` → `winstond` → `rpc.request` frame over the websocket → `gateway` → the backend API, **dispatched in-process** by calling the Hono app's `request()`.

Build:
- **In `winstond`:** a unix socket server accepting HTTP-shaped requests from local processes. Research whether Bun can serve HTTP on a unix socket directly, which would let the CLI use a normal fetch-style client. Forward each request as an `rpc.request` frame with the `WINSTON_RUN_TOKEN` it came with, and relay the `rpc.response`. Socket permissions let the `winston` user connect. Nothing but the socket is exposed.
- **In `gateway`:** a Hono app (for example `packages/vm-api`) mounted in-process. Middleware verifies the run token's signature and expiry, and checks that its user id matches the VM whose websocket carried the request. That check is what makes a stolen token useless. Handlers receive `{ userId, runId, runKind }` in context.
- First endpoints: `GET /v1/me` and `PATCH /v1/me` (time zone update, validated as an IANA zone, emitting nothing yet). They prove the path end to end.
- **Typed client:** export the Hono RPC app type from `packages/shared`, so the CLI gets end-to-end types.
- **Errors:** always `{ error: { code, message, hint } }` with a fixed set of codes that the CLI maps to exit codes (§11).

Tests:
- A valid token over the right VM succeeds.
- A valid token presented over a *different* VM's connection is rejected.
- Expired and tampered tokens are rejected.
- The error shape is enforced.

## Outcome

Built as described in docs/design.md §15 ("The request path as built").
- **API package:** the API is its own package, `packages/vm-api`, which exports `createVmApi` and `type VmApi` for the CLI's typed client. The type isn't in `packages/shared` (business-agnostic by design) or `packages/domain`, because the API needs the database.
- **Socket path:** `/run/winstond/winstond.sock` instead of `/run/winstond.sock`, since the non-root `winstond` gets `/run/winstond` from systemd's `RuntimeDirectory=`.
- **Carrying VM's identity:** it rides the connection (`VmSocketData.userId`), and the API reads it only from Hono's env.
- **Error codes:** fixed in `@winston/domain/api-errors`, with statuses and exit codes.
- **Tests:** API auth (valid, other user's VM, expired, tampered, missing), the error shape, `/v1/me` read and update. Gateway RPC for own user and for another user's token. `winstond`'s socket relaying and the `unavailable` path.
- **End to end in the real VM:** the same checks over the real socket.
