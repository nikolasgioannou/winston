---
id: "efdf9d"
title: Ramp hasn't allowlisted Winston's production redirect
status: todo
priority: none
labels:
  - collab
  - infra
parent: "80fcf0"
created_at: 2026-10-05T23:00:34.584Z
updated_at: 2026-10-05T23:01:41.824Z
---

Ramp lets a custom MCP client complete OAuth on a hosted redirect only after allowlisting it (research doc, "What Ramp offers"). Until then, Ramp works only in local development.

**What to do**

- The founder submits the request form (https://docs.ramp.com/developer-api/v1/mcp-redirect-whitelist-request) for exactly `https://runwinston.com/auth/ramp/connect/callback`. Turnaround isn't published, so start early.
- Once approved, register production's client with dynamic registration, and put its client id in production config alongside the Google client (`infra/src/secret-names.ts` or plain config, since a public client has no secret).
- `docs/runbooks/` gets a Ramp page: the redirect, how the client was registered, and how to register again.

**Done when**

- [ ] Ramp confirms the redirect is allowlisted
- [ ] Production has a registered client id, and the runbook says how it was made
