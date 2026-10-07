---
id: "aa06d1"
title: We don't know how Ramp's MCP server behaves after a real sign-in
status: done
priority: none
labels:
  - collab
  - connectors
  - spike
parent: "80fcf0"
created_at: 2026-10-05T23:00:34.531Z
updated_at: 2026-10-07T15:04:30.843Z
---

The spec (80fcf0) rests on Ramp's published metadata and the agent-tools spec in Ramp's CLI. Before building, confirm what only a real sign-in shows. It needs the founder's Ramp account (or a Ramp sandbox account against `https://demo-mcp.ramp.com/mcp`).

**What to find out**, with a throwaway local script outside the repo (no client code lands here):

- Dynamic registration at `https://mcp.ramp.com/register` accepts a `localhost` redirect without allowlisting, and what it returns (client id, any expiry on the registration).
- The authorize request honours a subset of scopes, and what the consent screen shows.
- The token response: `expires_in`, whether `refresh_token_expires_in` is set, and whether refreshing **rotates** the refresh token and what happens when a spent one is reused (does Ramp revoke the whole grant?).
- `tools/list`: the real tool names, input schemas and annotations for everything the read and write tickets need (transactions, reimbursements, requests, bills, the attention feed, approve/reject, edit, submit), and how they compare to `agent-tool.json` in `ramp-public/ramp-cli`.
- The shape of `tools/call` results (text, JSON, `structuredContent`), errors (missing scope, not found, the 100-row limit, "ETL operation limit reached"), and paging.
- Which tool gives the signed-in user's email and business, and what an employee sees compared with an admin.
- Whether sessions (`mcp-session-id`) expire, and whether a call works without `initialize` each time.

**Done when**

- [x] Each question above has an answer in `docs/research/ramp-mcp.md` ("To verify first" becomes "Verified")
- [x] Synthetic response fixtures, shaped exactly like Ramp's (no real data), are written down for the connector tickets to test against
- [x] Anything that contradicts 80fcf0's spec is raised with the founder, and the spec is updated


## As built

Done 2026-10-07 with the founder's production Ramp account (an admin), using a throwaway script outside the repo. It signed in once with ten read scopes and made read-only calls. The answers are under "Verified" in `docs/research/ramp-mcp.md`.

- **Fixtures:** recorded there as shapes (field names and types) rather than JSON files, with no data from the account. The connector tickets build their test fixtures from them.
- **The test grant:** the local tokens were deleted. Ramp won't let a public client revoke, so the grant (shown as "Ramp MCP Remote") stays in Ramp's connected AI tools until the founder removes it there.
- **What contradicted the spec and was raised:**
  - Disconnecting can't revoke at Ramp.
  - Ramp gives no business name.
  - Scopes don't split by capability, so Winston's routes enforce the toggles.
  
  8f6c44, 93ff50, 02441f and 80fcf0 now say so.
