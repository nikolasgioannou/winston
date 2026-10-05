---
id: "8f6c44"
title: The user can't connect a Ramp account
status: todo
priority: none
labels:
  - backend
  - cli
  - connectors
  - db
  - web
parent: "80fcf0"
created_at: 2026-10-05T23:01:06.580Z
updated_at: 2026-10-05T23:01:42.029Z
blocked_by:
  - "74641a"
  - "93ff50"
---

The spec (80fcf0): a Ramp connection like a Google one, with domain `ramp`, provider `ramp` and capabilities `read` (on), `edit`, `submit` and `approve` (off).

**What to build**

- **Vocabulary and data:** `ramp` in `connectionDomains`, `connectionProviders`, `capabilitiesByDomain`, `defaultCapabilities`, `capabilityScopes` (each capability's Ramp scopes) and the per-provider description from 74641a (no sync, no watch, rotating tokens, revocable). One migration adding the enum values (`ALTER TYPE … ADD VALUE`, as `winston` was added).
- **Client registration:** one public client per environment through dynamic registration, its id in config (`RAMP_OAUTH_CLIENT_ID`, plus `RAMP_MCP_URL`, defaulting to production). `scripts/setup.sh` registers a `localhost` client for a new contributor when `.env.local` has none (check first, then act), and `.env.example` lists both.
- **Connect flow** in `apps/web`, beside Google's: `/auth/ramp/connect` (with `?reconnect=<acct_id>`) and `/auth/ramp/connect/callback`, with the state and PKCE cookies, asking only for the spec's scopes and never the excluded ones. The callback exchanges the code, checks which scopes came back, finds the user's email and business through Ramp's user tool, and calls `saveConnection` (email as `external_email`; the business name kept on the connection and shown with it).
- **Disconnect** revokes the Ramp token (unlike Google, it doesn't touch other connections).
- **`winston accounts connect ramp`** prints the link, and `accounts list|get` show Ramp connections with their capabilities and links.

**Done when**

- [ ] Locally, the founder connects Ramp from the link, sees it in `winston accounts list`, disconnects it, and the token is revoked
- [ ] Tests: callback with all scopes, with a scope missing (that capability is unavailable), a bad state, reconnecting the same login, and the setup script being safe to re-run
- [ ] `design.md` §5 (Connections & credentials) and `product.md` §4 describe Ramp connections
