---
id: "8f6c44"
title: The user can't connect a Ramp account
status: in-progress
priority: none
labels:
  - backend
  - cli
  - connectors
  - db
  - web
parent: "80fcf0"
created_at: 2026-10-05T23:01:06.580Z
updated_at: 2026-10-07T15:26:55.432Z
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
- [x] Tests: callback with all scopes, with a scope missing (that capability is unavailable), a bad state, reconnecting the same login, and the setup script being safe to re-run
- [x] `design.md` §5 (Connections & credentials) and `product.md` §4 describe Ramp connections


**From the spike (aa06d1, 2026-10-07):** the scopes are as in the "Verified" section of `docs/research/ramp-mcp.md`, which also shows that a subset of scopes is honoured. There's no `refresh_token_expires_in`, so the grant sweep doesn't change: a Ramp connection expires only when a refresh is refused. Ramp renames every registered client "Ramp MCP Remote", so that's what users see on Ramp's screen and in its connected tools.


## As built (waiting on the founder's local check)

- **Vocabulary:** `ramp` is a domain and a provider (migration `ramp_connections`), issuer `ramp`, not synced. Capabilities `read` (on), `edit`, `submit` and `approve` (off).
- **Scopes:** `capabilityScopes` is now a list per capability, since a Ramp capability needs several scopes. Connecting asks for their union (`rampConnectScopes`), and `unavailableCapabilities` marks one unavailable if any of its scopes is missing.
- **Ramp's OAuth** is in `@winston/connectors/ramp-auth`: the sign-in URL, the code exchange, the refresher for `rotatingAccessTokens`, and the user's email through MCP. PKCE's `codeChallenge` moved to `@winston/shared/tokens`. Endpoints are production's: Ramp's sandbox server can't use production accounts, and the founder tests with their real one. So no `RAMP_MCP_URL`.
- **Routes:** `/auth/ramp/connect` and `/callback` beside Google's. The connect cookies now take the flow's path, so the two flows never read each other's. Google's flow only accepts Google's domains (`isGoogleDomain`). `?next` after sign-in may go to either connect flow. A new `unavailable` problem covers a missing `RAMP_OAUTH_CLIENT_ID`.
- **Client:** `scripts/ramp-client.ts <redirect>` registers one. It's standalone because root scripts can't import workspace packages. `scripts/setup.sh` registers the local client once (checked by re-running: "Ramp client set").
- **Disconnecting:** `rampTokenRevoker` is a no-op, because Ramp refuses revocation from a public client.
- **Site and CLI:** Ramp's names, capability copy, the `accounts connect ramp` text and the vm-api notes are in, as the records require. Its icon and its entry in the Add account dialog are 0bfa49's, so for now the link comes from `winston accounts connect ramp`.
- **Docs:** `docs/runbooks/ramp.md` (new), `design.md` §5 and §14, `product.md` §4.
- **Tests:** `connect-ramp.server.test.ts` covers the account saved with only `read` on, the token sealed and no watch; missing read scopes; a bad state; a refusal; no client; reconnecting the same login. `ramp-auth.test.ts` covers the requested scopes (none of the never-offered ones) and refreshing. The domain tests cover capabilities left unavailable by a missing scope.
