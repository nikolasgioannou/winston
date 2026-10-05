---
id: "93ff50"
title: The backend can't call an MCP server
status: todo
priority: none
labels:
  - backend
  - connectors
parent: "80fcf0"
created_at: 2026-10-05T23:01:06.528Z
updated_at: 2026-10-05T23:01:41.978Z
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

- [ ] Tests against a fake MCP server (Streamable HTTP, plain JSON and SSE replies) cover initialize, a call, an expired session, a 401 that refreshes once, and the error mapping
- [ ] `design.md` §5 describes the client and why the SDK or a hand-written one was chosen
