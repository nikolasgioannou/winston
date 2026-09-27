---
id: "76c143"
title: Create the api service with Hono
status: done
priority: none
labels:
  - backend
  - m1
created_at: 2026-09-27T05:30:54.297Z
updated_at: 2026-09-27T19:03:50.272Z
blocked_by:
  - "2c5ac8"
  - "9378a8"
---

`apps/api` holds Winston's **public** endpoints only: the Telegram webhook, Google push notifications and OAuth callbacks (docs/design.md §9 and §15). The CLI's API does not live here. It lives behind `gateway`.

Research Hono on Bun before writing it: app structure for a growing set of routes, middleware (request ids, logging, error handling), how `Bun.serve` hosts a Hono app, and how Hono's typed RPC works. We use Hono RPC types for the VM-facing API in `gateway`, so understand it now and keep conventions consistent across both.

Build:
- Server startup from config (port and host), with a structured logger and a request id per request.
- A global error handler that logs and returns a generic 500 without leaking internals.
- `GET /health` for the load balancer, checking DB connectivity cheaply.
- A route module pattern that the webhook tickets will follow.

Test the health route and the error handler with Hono's in-process request helper, without opening a real port.

## Outcome

Built as described in docs/design.md §9 (`api`). Config is `API_HOST` and `API_PORT` (defaults `127.0.0.1:3000`, the tunnel's origin) plus the shared `LOG_LEVEL`. Route modules live in `apps/api/src/routes/` as factories returning a chained `Hono<ApiEnv>`, so their types carry over to Hono RPC. `AppType` isn't exported yet because nothing consumes the api's types; `gateway` will be the first RPC consumer, with its own app.
