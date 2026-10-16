---
id: "efdf9d"
title: Ramp hasn't allowlisted Winston's production redirect
status: done
priority: none
labels:
  - collab
  - infra
parent: "80fcf0"
created_at: 2026-10-05T23:00:34.584Z
updated_at: 2026-10-16T14:11:53.346Z
---

Ramp lets a custom MCP client complete OAuth on a hosted redirect only after allowlisting it (research doc, "What Ramp offers"). Until then, Ramp works only in local development.

**What to do**

- The founder submits the request form (https://docs.ramp.com/developer-api/v1/mcp-redirect-whitelist-request) for exactly `https://runwinston.com/auth/ramp/connect/callback`. Turnaround isn't published, so start early.
- Once approved, register production's client with dynamic registration, and put its client id in production config alongside the Google client (`infra/src/secret-names.ts` or plain config, since a public client has no secret).
- `docs/runbooks/` gets a Ramp page: the redirect, how the client was registered, and how to register again.

**Done when**

- [x] Ramp confirms the redirect is allowlisted
- [x] Production has a registered client id, and the runbook says how it was made


## As built

- **Approved:** Ramp support approved `https://runwinston.com/auth/ramp/connect/callback` on 2026-10-07 (request #1806816).
- **Registered:** on 2026-10-16 with `bun scripts/ramp-client.ts`. Ramp returned the same client id it gave the spike's and the local registrations, so its registration seems to hand out one shared public client, and the allowlisted redirect is what's Winston's.
- **Where the id lives:** it's not a secret, so it's in code (`rampClientId` in `infra/src/services.ts`), set as `RAMP_OAUTH_CLIENT_ID` for `web` and the gateway, rather than in Secrets Manager.
- **Runbook:** `docs/runbooks/ramp.md` (Production).
- **Not live yet:** production gets it with the next deploy after this branch lands. The founder is testing locally first.
