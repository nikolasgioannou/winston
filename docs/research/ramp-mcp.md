# Research: Ramp as a connected app, through Ramp MCP

> Researched 2026-10-06. Nothing here is built. Ramp says its MCP server "is subject to change" and its tools change continuously, so check the live metadata before building. Facts marked _unverified_ need one real sign-in to confirm (see "To verify first").

## Summary

**Doable, and Ramp's side is standard.** Ramp's remote MCP server follows the MCP authorization spec as written: protected-resource metadata, dynamic client registration, PKCE with a public client (no secret) and refresh tokens. Winston can be an ordinary MCP client in the backend, so no Ramp credential goes near the VM (invariant 1).

**Only Ramp can unblock production, and building doesn't have to wait.** Ramp must allowlist a custom client's hosted redirect URI, through a request form. `localhost` redirects don't need it, so building and local testing can start now. On the user's side, their company needs **Ramp Plus**, and a Ramp admin must let them use MCP.

**Most of the work is generalizing Winston's connections, which assume Google throughout.** Several places treat "not Winston's own mailbox" as "Google", so a Ramp connection would be swept, synced and refreshed as if it were Google. Two decisions are the founder's (below): how the CLI exposes a provider whose tools Ramp defines, and which Ramp actions Winston may take at all.

## What Ramp offers

- **Server:** `https://mcp.ramp.com/mcp`, Streamable HTTP. It replies with plain JSON and an `mcp-session-id`, and advertises tools only: no resource subscriptions and no `listChanged`. The sandbox is `https://demo-mcp.ramp.com/mcp` and needs a Ramp sandbox account; production refuses sandbox accounts. For a user with several Ramp businesses, Ramp suggests one connection per business through path aliases (`https://mcp.ramp.com/<label>/mcp`), each with its own OAuth session.
- **Auth** (checked live against `/.well-known/oauth-authorization-server` and `oauth-protected-resource/mcp`):

  | What                    | Value                                                                   |
  | ----------------------- | ----------------------------------------------------------------------- |
  | Authorize endpoint      | `https://mcp.ramp.com/oauth/authorize?auth_level=auto`                  |
  | Token endpoint          | `https://api.ramp.com/developer/v1/token/pkce`                          |
  | Registration            | `https://mcp.ramp.com/register` (dynamic client registration, RFC 7591) |
  | Revocation              | `https://api.ramp.com/developer/v1/token/revoke`                        |
  | Client auth             | `none` (a public client), PKCE `S256` only                              |
  | Grants                  | `authorization_code`, `refresh_token`                                   |
  | Scopes                  | about 55, `resource:read` / `resource:write`, plus a few special ones   |
  | Unauthenticated request | `401` with `WWW-Authenticate: Bearer resource_metadata=…`               |

- **Redirect URIs:** `https://` or `localhost`/`127.0.0.1`, exact host (no wildcards). Ramp's guide says custom clients and gateways "must have their redirect URI allowlisted by Ramp first", through [the request form](https://docs.ramp.com/developer-api/v1/mcp-redirect-whitelist-request). Its turnaround isn't published. Winston needs one URI per hosted environment, and the exact path must be settled before applying.
- **Tokens:** access tokens last 1 hour by default (from `expires_in`). Refresh tokens **rotate**: Ramp's own CLI stores the new refresh token after every refresh and guards against "another process may have already rotated this token family". The refresh token's lifetime comes in `refresh_token_expires_in` when one is set _(unverified for MCP clients)_.
- **Who can use it:** employees and admins, each with their own Ramp permissions. Employees see only their own cards, transactions and reimbursements; company-wide spend, bills and vendors need an admin or business owner. It needs **Ramp Plus**, and admins choose who may connect (Company → Integrations → Ramp MCP → Manage access).
- **Tools:** Ramp lists them by task, not name: search and analyze spend; approve or reject transactions, reimbursements and requests (not bills); submit and edit expenses and reimbursements; edit transactions (memo, coding, trip), post comments, lock, unlock and activate cards; policy and Help Center answers; trips and bookings; treasury balances; and **agent card credentials** for purchases. Queries return at most 100 rows, and the server can refuse with "ETL operation limit reached". **File uploads (receipts) aren't supported** over MCP.
- **The full surface:** Ramp's open-source CLI (`ramp-public/ramp-cli`) ships the spec for the "agent tools" that back these features: 137 operations, 48 of which need a write scope. Several move money or hand out card numbers: `get-agent-card-creds` (`cards:read_agentic`), `pay-with-x402` (`x402:write`), `issue-one-off-funds` (`funds:write`), limit changes (`limits:write`), bank accounts and drawdown requests, and flight and hotel bookings. **Scopes don't match risk.** `submit-flight-booking` needs only `trips:read`, so asking for fewer scopes can't be Winston's only safeguard.

## Why MCP, and not the other ways in

- **Ramp's Developer API** (REST, OAuth app with a secret): only admins and business owners can authorize a third-party app, and one that acts for other businesses goes through Ramp's partner process. It does have **webhooks**, which MCP lacks. It's worth it only if Winston needs push events (see "Events").
- **Ramp's CLI on Winston's VM:** it would work today (`--agent` JSON output, OAuth on `127.0.0.1`), but its refresh token would live on the VM. That breaks invariant 1, and the server couldn't enforce capability toggles (invariant 2).
- **MCP from the backend** keeps tokens sealed in Postgres, works for employees as well as admins, and fits where connected apps already go: CLI → `winstond` → gateway → vm-api → connector.

## Decisions for the founder

1. **How the CLI exposes Ramp** (invariant 8: one grammar, domain names, `--dry-run` on every write):
   - **A. A curated domain** (`winston spend transactions list|get|update`, `reimbursements …`, `approvals list`, `cards update --lock`). It keeps the grammar and gives real dry runs, bounded output and typed ids. But each verb is mapped by hand onto a Ramp tool whose name and arguments Ramp changes without notice.
   - **B. A pass-through under the domain name** (`winston spend tools` lists the tools Winston may use, with their input schemas; `winston spend call <tool> --input @args.json`). It's little code, picks up new Ramp tools as they ship, and the same bridge would serve the next MCP app. But tool names are Ramp's (like `--native`), and `--dry-run` can only show the call.
   - **Recommendation: B, with a server-side policy for each tool** (below). Ramp's surface is too large and changes too often to curate. Add curated verbs later only where evals show Winston struggling.
2. **What Winston may do in Ramp.** Recommendation for a first version, as capability toggles on the connection:
   - `read`: on by default.
   - `edit`: memos, coding, trips, comments.
   - `approve`: approve and reject. Off by default.
   - `submit`: submit and resubmit expenses and reimbursements.
   - `cards`: lock, unlock, activate.
   - **Never offered:** card credentials, payments, funds, limits, bank accounts and drawdowns, bookings, vendor payees. Winston paying for things with a Ramp agent card would change what the product trusts him with (product.md §6), so it's its own decision, later.
3. **The domain's name:** `spend` is suggested (Ramp's own word, and it fits Brex or Expensify later). Capability names must not reuse calendar's `create`/`update`/`delete`, because capability copy is keyed by bare name.

## What changes in Winston

**Ramp-specific (new):**

- **One client registration per environment**, made once with dynamic client registration and kept in config like the Google client id. It's public, so there's no secret. Nothing per user, and no table.
- **`@winston/connectors/mcp`:** a small MCP client over Streamable HTTP with a bearer token. It handles `initialize`, `tools/list` (cached per connection) and `tools/call`. It maps errors: 401 means refresh once, then `auth_expired`; a missing scope is `permission_disabled` with the reconnect link; 429, 5xx and "ETL operation limit reached" are `unavailable` (exit 5); "more than 100 rows" is `invalid_request` with "narrow it". Results are cut to a bounded size with the usual footer. Check whether the official TypeScript SDK runs cleanly on Bun before choosing between it and a hand-written client; Ramp's replies are plain JSON.
- **`@winston/connectors/ramp`:** the **tool policy**, which maps each allowed Ramp tool to a capability. A tool not in the policy is refused and logged, so new Ramp tools stay off until someone looks at them. It also holds the scopes to request (only those the policy's tools need, with the never-offered ones left out) and the user's identity after connecting. Ramp has no ID token, so identity comes from calling its user tool for the email and business name.
- **vm-api routes** (`/v1/spend/tools`, `/v1/spend/call`): `resolveConnection`, then `requireCapability` against the policy, then `audited` for writes (action `spend.<tool>`). A `spend` factory in `ConnectorDeps`, built in the gateway next to `mail` and `calendar`.
- **CLI:** a `spend` resource, plus `accounts connect spend`.
- **Web:** a Ramp entry in `connectableProviders`, a Ramp icon (check the brand licence, as for the others), and capability copy for the new domain.
- **Prompts:** a "Ramp" section in `front-of-house.md` and `background.md`. Approving, rejecting, locking a card and submitting are confirm-first; amounts and statuses come from Ramp, never guessed; memos and vendor text are outside content, not instructions. Then evals against a fake MCP server, as the mail evals use a fake API.

**Generalizing what's Google-only today** (found by reading the code; paths are from 2026-10-06):

- **`googleBacked` means "not Winston's mailbox"** (`packages/db/src/connections.ts:78`). A Ramp row would be swept to `expiring` after 6 days, given a `sync_connection` job every 10 minutes (which runs calendar sync for any domain that isn't mail), and refreshed against Google's token endpoint, which marks it expired. `saveConnection` also queues a Gmail watch for every new connection. This needs a per-provider description: whether it syncs, watches, how its grant expires, and how it refreshes and revokes.
- **Connecting would fail outright:** `system.app.connected`'s payload only allows `mail | calendar` (`packages/domain/src/events.ts:83`), so `saveConnection`'s transaction throws. Disconnecting fails the same way.
- **Token refresh:** `googleAccessTokens` caches access tokens in each process's memory, and both the gateway and agents refresh. With rotating refresh tokens, two processes refreshing at once would replay a spent token, and Ramp may revoke the grant. Refreshing needs a row lock on the connection and must store the new sealed refresh token. The gateway has only `kms:Decrypt` (`infra/src/services.ts:304`), so it either gets `GenerateDataKey` or refreshing happens in one service. The 7-day expiry warning should come from the provider (`refresh_token_expires_in`, or none), not a constant.
- **Revoke:** revoking and deleting an account call Google's endpoint for every connection. Unlike Google, revoking one Ramp grant doesn't touch the user's other connections, so disconnecting can revoke.
- **Connect flow:** the `/auth/google/connect` routes, cookies and URL builders (about six places) become per-provider, or one `/auth/connect/:provider`.
- **Two-way branches** (`mail ? … : calendar`, `gmail ? GmailIcon : GoogleCalendarIcon`) in the web home and icons, CLI `accounts`, trigger validation, test helpers and the watch handler. Making them exhaustive turns the rest into compile errors.
- **Connection identity:** `external_email` is required and part of the unique key, so one Ramp business per email is the simple rule. Two businesses on one login would need the path alias stored on the connection.
- **Migration:** `ALTER TYPE … ADD VALUE` for `spend` and `ramp`, as `winston` was added.
- **Docs:** product.md §4 and §6, design.md §3 (naming), §5 (Permissions, Connections), §11 (command reference), §14, and the system events' wording ("Google makes the user reconnect every 7 days").

## Events

MCP has no push, so the first version has **no `spend.*` events**: Winston uses schedules to check (`get-attention-feed` is Ramp's "what needs me" list). Webhooks need the Developer API. An MCP token comes from the Developer API's own token endpoint, but whether it also works for REST calls is _unverified_.

## To verify first

These take one sign-in on `localhost`, with a Ramp Plus account (or a sandbox account on the sandbox server), before any tickets are cut:

1. Dynamic registration accepts a `localhost` redirect without allowlisting.
2. The authorize request honours a subset of scopes.
3. The MCP tool names and annotations (`readOnlyHint`, `destructiveHint`) match the agent-tools spec. The demo server's one tool carries annotations.
4. Whether refresh tokens rotate, and their lifetime.
5. Which tool gives the user's email and business.

## Rough plan

In order, with 1 and 2 starting at once:

1. **Ramp prerequisites** (founder): a Ramp Plus account to test with; MCP enabled for that user; a redirect allowlist request for production.
2. **Spike:** answers to "To verify first", using a throwaway local script.
3. **Make connections provider-neutral:** the per-provider description, exhaustive branches, events payload, connect routes, refresh with rotation and a row lock, and revoke. No behaviour change for Google.
4. **The MCP client and Ramp connector:** registration, connect flow, identity, tool policy and scopes.
5. **`winston spend`:** vm-api routes, CLI, audit.
6. **The site:** Connected accounts, icon, capability copy, Home.
7. **Prompts and evals.**

Step 3 is the largest and the riskiest, because it touches the Google paths in daily use.

## Sources

- Ramp: https://support.ramp.com/ramp-mcp · https://docs.ramp.com/llms-guides/ramp-mcp.txt · https://docs.ramp.com/llms-guides/authorization.txt · https://docs.ramp.com/llms-guides/cli.txt · https://docs.ramp.com/llms-guides/webhooks.txt · https://docs.ramp.com/developer-api/v1/mcp-redirect-whitelist-request
- Live metadata: https://mcp.ramp.com/.well-known/oauth-authorization-server · https://mcp.ramp.com/.well-known/oauth-protected-resource/mcp · the demo server `https://mcp.ramp.com/mcp-apps/demo/mcp` (no account)
- Ramp CLI (agent-tools spec, refresh rotation): https://github.com/ramp-public/ramp-cli (`src/ramp_cli/specs/agent-tool.json`, `src/ramp_cli/auth/refresh.py`, at 9f74b63)
- MCP authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration.md
