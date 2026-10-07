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
updated_at: 2026-10-07T15:04:20.494Z
blocked_by:
  - "74641a"
  - "93ff50"
---

The spec (80fcf0): a Ramp connection like a Google one, with domain `ramp`, provider `ramp` and capabilities `read` (on), `edit`, `submit` and `approve` (off).

**What to build**

- **Vocabulary and data:** `ramp` in `connectionDomains`, `connectionProviders`, `capabilitiesByDomain`, `defaultCapabilities`, `capabilityScopes` (each capability's Ramp scopes) and the per-provider description from 74641a (no sync, no watch, rotating tokens, revocable). One migration adding the enum values (`ALTER TYPE … ADD VALUE`, as `winston` was added).
- **Client registration:** one public client per environment through dynamic registration, its id in config (`RAMP_OAUTH_CLIENT_ID`, plus `RAMP_MCP_URL`, defaulting to production). `scripts/setup.sh` registers a `localhost` client for a new contributor when `.env.local` has none (check first, then act), and `.env.example` lists both.
- **Connect flow** in `apps/web`, beside Google's: `/auth/ramp/connect` (with `?reconnect=<acct_id>`) and `/auth/ramp/connect/callback`, with the state and PKCE cookies, asking only for the spec's scopes and never the excluded ones. The callback exchanges the code, checks which scopes came back, finds the user's email through `ramp_get_simplified_user_detail` (which gives the business id but no name), and calls `saveConnection` with the email as `external_email`.
- **Disconnect** deletes the token. Ramp won't let a public client revoke (aa06d1), so the provider's revoker is a no-op, and the site and `accounts` say the user can remove Winston under Ramp's connected AI tools.
- **`winston accounts connect ramp`** prints the link, and `accounts list|get` show Ramp connections with their capabilities and links.

**Done when**

- [ ] Locally, the founder connects Ramp from the link, sees it in `winston accounts list`, disconnects it, and the token is gone from the database
- [ ] Tests: callback with all scopes, with a scope missing (that capability is unavailable), a bad state, reconnecting the same login, and the setup script being safe to re-run
- [ ] `design.md` §5 (Connections & credentials) and `product.md` §4 describe Ramp connections


**From the spike (aa06d1, 2026-10-07):** the scopes are as in the "Verified" section of `docs/research/ramp-mcp.md`, which also shows that a subset of scopes is honoured. There's no `refresh_token_expires_in`, so the grant sweep doesn't change: a Ramp connection expires only when a refresh is refused. Ramp renames every registered client "Ramp MCP Remote", so that's what users see on Ramp's screen and in its connected tools.
