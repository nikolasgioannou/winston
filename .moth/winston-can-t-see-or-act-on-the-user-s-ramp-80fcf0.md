---
id: "80fcf0"
title: Winston can't see or act on the user's Ramp
status: todo
priority: none
labels:
  - collab
  - connectors
  - spec
created_at: 2026-10-05T23:00:20.335Z
updated_at: 2026-10-05T23:01:41.721Z
---

Specified with the founder 2026-10-06, from the research in `docs/research/ramp-mcp.md`. The work is filed as sub-tickets under this one.

The user connects their Ramp account on the site, as they connect Gmail and Calendar. Winston can then see their transactions, reimbursements and everything waiting on them, keep transactions tidy (memos, coding, trips), submit reimbursements, and approve or reject what's theirs to approve. Each of those is a capability the user switches on, enforced by the server.

## Spec

**Built the way Gmail and Calendar were** (docs/design.md §5 Permissions, Connections & credentials): a connection per Ramp login, its refresh token sealed in the backend, capability toggles on the site, and a provider in `@winston/connectors` behind vm-api routes, with `resolveConnection`, `requireCapability`, `audited` and `--dry-run`. The CLI is a curated set of commands with normalized output and typed ids, not a pass-through of Ramp's tools.

**How Winston reaches Ramp:** Ramp's remote MCP server (`https://mcp.ramp.com/mcp`), called from the backend over Streamable HTTP with the user's access token. The user's Ramp role decides what they can see: employees see their own spend, and admins see the company's. Their company needs Ramp Plus, and a Ramp admin must allow them MCP. The CLI, an admin-only Developer API app and Ramp's own CLI on the VM were ruled out (research doc, "Why MCP").

**Naming: by provider.** The connection's domain is `ramp` (provider `ramp`), and the CLI is `winston ramp …`. This departs from §11's "domain names, never provider names" (invariant 8), agreed with the founder. They mean to move mail and calendar to `winston gmail` and the like later, which isn't part of this work.

**Capabilities** (toggled per connection; only `read` starts on, as for mail and calendar):

| Capability | Covers                                                                         |
| ---------- | ------------------------------------------------------------------------------ |
| `read`     | Transactions, reimbursements, requests, bills, and what's waiting on the user   |
| `edit`     | Transaction memo, accounting coding and trip; reimbursement details; comments  |
| `submit`   | Submitting the user's own draft reimbursements                                 |
| `approve`  | Approving and rejecting transactions, reimbursements and requests              |

Each capability maps to the Ramp scopes it needs (`capabilityScopes`), so a capability whose scope wasn't granted shows as unavailable, as with Google.

**Never in this work:** card credentials and agent cards, x402 payments, issuing funds, limit changes, bank accounts and drawdowns, flight and hotel bookings, vendor payees, and card lock/unlock. The connect flow never asks for their scopes (`cards:read_agentic`, `x402:write`, `x402_provisioning:write`, `funds:write`, `limits:write`, `bank_accounts:write`, `banking_drawdown_requests:write`, `agent_wallet_policy:write`, `cards:write`), and no route calls those tools. Letting Winston spend money is its own decision, later.

**Commands** (`winston ramp <object> <verb>`, the standard verbs and flags where they apply; the exact flags are set in the read and write tickets):

```
winston ramp approvals list                       What's waiting on the user: transactions, reimbursements, requests, bills
winston ramp transactions list|search|get|update|approve|reject
winston ramp reimbursements list|search|get|update|submit|approve|reject
winston ramp requests list|get|approve|reject
winston ramp bills list|get                       Read only (Ramp's MCP can't approve bills)
```

Ids: `txn_`, `rmb_`, `req_`, `bil_` through `external_refs`, so `winston get` resolves them.

**Out of scope:** Ramp events and subscriptions (MCP has no push; Winston checks on schedules he sets himself); receipt uploads (MCP takes no files); cards, balances and policy questions; more than one Ramp business per login email.

**Production needs Ramp:** our callback (`https://runwinston.com/auth/ramp/connect/callback`) must be allowlisted by Ramp before anyone outside local development can connect. Local development uses `localhost`, which needs no approval.

**Docs:** each sub-ticket updates `product.md` (§4, §6) and `design.md` for what it builds.

**Done when**

- [ ] Every sub-ticket is done
- [ ] In production, the founder connects Ramp, Winston lists what's waiting on them, and approves a reimbursement after a yes in chat
