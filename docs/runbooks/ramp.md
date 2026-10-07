# Ramp

Winston connects users' Ramp accounts through Ramp's remote MCP server (docs/design.md §5, 80fcf0). How Ramp behaves is in [docs/research/ramp-mcp.md](../research/ramp-mcp.md) ("Verified").

## The client

Each environment has one Ramp client, made with Ramp's dynamic registration for exactly one redirect URI.

- **Public client:** it has no secret. Its id is all the environment keeps, as `RAMP_OAUTH_CLIENT_ID` (read by `web` to connect, and by the gateway to refresh tokens).
- **Its name:** Ramp names every registered client "Ramp MCP Remote", whatever was sent, so that's what users see on Ramp's consent screen and under its connected AI tools.

To register one:

```bash
bun scripts/ramp-client.ts <redirect URI>
```

It prints the client id.

### Local

`scripts/setup.sh` registers a client for `http://localhost:3002/auth/ramp/connect/callback` the first time and writes its id into `.env.local`. Ramp needs no approval for a `localhost` redirect, so any Ramp account can connect locally:

- Any plan works.
- A Ramp admin must allow the user under Company → Integrations → Ramp MCP → Manage access.
- Ramp's sandbox accounts can't use the production server.

### Production

The redirect is `https://runwinston.com/auth/ramp/connect/callback`. Ramp must allowlist it before Ramp can be connected in production.

- **Requested:** the founder submitted the allowlist form on 2026-10-07, as an External app (https://docs.ramp.com/developer-api/v1/mcp-redirect-whitelist-request).
- **When Ramp approves:** register the client with the script and put its id in production config (efdf9d).

## Disconnecting

A public client can't revoke at Ramp (`/developer/v1/token/revoke` wants client credentials), so disconnecting deletes Winston's tokens only. Ramp's connected AI tools page is read-only, so a user who wants Ramp's side cleared too asks Ramp support. With its tokens deleted, the old grant is no use to anyone: the access token lapses within an hour, and no one holds the refresh token.
