---
id: "93ff50"
title: The backend can't call an MCP server
status: done
priority: none
labels:
  - backend
  - connectors
parent: "80fcf0"
created_at: 2026-10-05T23:01:06.528Z
updated_at: 2026-10-07T15:16:11.461Z
blocked_by:
  - "aa06d1"
---

Winston reaches Ramp through its remote MCP server (80fcf0), and nothing in the repo speaks MCP yet.

**Research first:** the official TypeScript SDK's client (`@modelcontextprotocol/sdk`, Streamable HTTP transport): its current version, whether it runs cleanly on Bun, and what it pulls in. Ramp answers in plain JSON, so a small hand-written client is the fallback. Decide from what the spike (aa06d1) showed about sessions and results.

**What to build:** `@winston/connectors/mcp`

- A client for one server URL and an access-token callback: `initialize` (once per session, re-initializing when the session is gone), `tools/call` with a timeout, and the result as text or structured JSON.
- Errors map to the connector errors the vm-api already turns into exit codes: 401 refreshes once through the token callback, then `ConnectionUnavailableError` (`auth_expired`); 429, 5xx and timeouts are `unavailable` (exit 5, safe to retry); a tool error comes back as an error the provider can interpret.
- It calls only tools by name. There's no general "call any tool" path, so it can't be used to reach tools the spec leaves out.

**Done when**

- [x] Tests against a fake MCP server (Streamable HTTP, plain JSON and SSE replies) cover initialize, a call, an expired session, a 401 that refreshes once, and the error mapping
- [x] `design.md` §5 describes the client and why the SDK or a hand-written one was chosen


**From the spike (aa06d1, 2026-10-07):** Ramp answers `initialize` with plain JSON and an `mcp-session-id`. Results are a single `text` item holding JSON. Ramp's own errors (403, not found) come back with `isError: false` and a JSON body of `{ error: true, status_code, error_code, message }`, so the client must check the body and map `status_code` the way it maps HTTP statuses. Validation errors come back with `isError: true` and plain text. Every Ramp tool requires a `rationale` argument; the client can fill it from the CLI command being run.


## As built

- **`mcpClient`** (`packages/connectors/src/mcp.ts`, exported as `@winston/connectors/mcp`) is hand-written: `@modelcontextprotocol/sdk` 1.32.1 depends on Express, CORS, hono's node server and more, for a client that needs `initialize`, one notification and `tools/call`.
- **Behaviour:** a session per client (re-initialized once on a 404), plain JSON or SSE replies, a 30 s timeout, and one retry on 401 with a fresh token.
- **Errors:** `ProviderUnavailableError` for 429, 5xx, timeouts and network failures; the new `ProviderRefusedError` (API `invalid_request`) for other refusals and for `isError` results, carrying the tool's own text.
- **The rejected token:** `rotatingAccessTokens(id, rejected)` takes the token the server refused, so neither the cache nor the stored copy hands it back. Tested.
- **Tests:** against a fake server in `mcp.test.ts`, covering a session, SSE, a forgotten session, a refused token, 429 and 503, no answer at all, and a tool error.
