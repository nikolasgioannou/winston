---
id: "02441f"
title: Winston can't read the user's Ramp
status: in-progress
priority: none
labels:
  - backend
  - cli
  - connectors
parent: "80fcf0"
created_at: 2026-10-05T23:01:23.152Z
updated_at: 2026-10-07T15:43:20.953Z
blocked_by:
  - "52bf55"
  - "8f6c44"
---

The read side of `winston ramp` (80fcf0), built like reading mail from Gmail (6af84b): a provider interface with normalized models, the Ramp implementation over the MCP client (93ff50), vm-api routes behind `read`, and CLI commands.

**What to build**

- **Provider interface** (`@winston/connectors/ramp`): normalized transactions (amount and currency, merchant, card holder, date, memo, category and coding, receipt status, trip, approval state), reimbursements (amount, status, submitter, dates, memo), requests (kind, requester, amount, status), bills (vendor, amount, due date, status), and an approvals list across them of what's waiting on the user. The implementation calls Ramp's tools by name, as the spike (aa06d1) found them.
- **Bounded:** at most 100 rows per Ramp call, so filters narrow first; "more than 100 rows" becomes `invalid_request` telling Winston to narrow.
- **vm-api routes** under `/v1/ramp/…`, each with `resolveConnection` and `requireCapability(…, "read")`. A `ramp` factory in `ConnectorDeps`, built in the gateway with the rotating access-token helper (52bf55).
- **Ids:** `txn_`, `rmb_`, `req_` and `bil_` as `external_refs` kinds and prefixes in `packages/db/src/ids.ts`.
- **CLI:** `winston ramp <object> <verb>` needs one more level than today's `winston <resource> <verb>`, so the command table gains sub-resources, with `--help` and "Did you mean" at each level and `winston get` routing the new prefixes. Commands: `approvals list`; `transactions list|search|get`; `reimbursements list|search|get`; `requests list|get`; `bills list|get`. Lines start with the id and use the user's zone, as mail and calendar do; filters follow §11's standard flags (`--since`, `--until`, `--limit`, `--cursor`, `--account`) plus Ramp's own (`--status`, `--merchant`, `--min`/`--max` amount, `--mine` against the whole company for admins). The read ticket sets the exact flags and puts them in §11.

**Done when**

- [x] Tests against the spike's synthetic fixtures: the normalization of each object, paging, the 100-row error, and an employee's view against an admin's
- [x] vm-api tests: `read` off is `permission_disabled` with the link, an expired grant is `auth_expired`
- [ ] Locally, against the founder's Ramp, `winston ramp approvals list` and `winston ramp transactions search` give the expected results
- [x] `design.md` §11 (command reference, the provider-named exception, sub-resources) and §5 describe what's built (decision #81 already records provider naming)


**Added 2026-10-06 (from 52bf55):** the gateway is the first service to refresh Ramp's rotating tokens, so this ticket grants it `kms:GenerateDataKey` on the tokens key (`infra/src/services.ts`; its test currently asserts the gateway never seals, and `design.md` §13 and §19 say so). 52bf55 left the grant out because nothing used it yet.


**From the spike (aa06d1, 2026-10-07):** the tool names, shapes and paging are in the "Verified" section of `docs/research/ramp-mcp.md`. Amounts are display strings (`$12.34`) beside `original_amount` and `original_currency`, so parse them. `ramp_get_attention_feed` already groups what's waiting on the user by section, which is `approvals list`. `ramp_get_requests_to_review` requires a `thoughts` argument.


## As built (waiting on the founder's local check)

- **Provider:** `rampProvider` (`@winston/connectors/ramp`) over one MCP session per connection, kept by the gateway. It calls `ramp_get_attention_feed`, `ramp_get_transactions`, `ramp_get_full_transaction_metadata`, `ramp_get_reimbursements` (by uuid for `get`), `ramp_get_requests_to_review`, `ramp_get_unified_request_details`, `ramp_list_bills` and `ramp_get_bill_details`. Shapes come from the spike and Ramp's agent-tools spec (the reimbursement, request and bill responses are in it), parsed leniently.
- **Amounts:** kept as Ramp shows them (`$42.50`), or a number with its currency (`18.00 USD`), never re-formatted.
- **What's dropped:** `external_agent_messages` (outside content).
- **Errors:** Ramp's own, inside a successful result, map to `not_found`, refused (403 with a role hint, "more than 100 rows" with "narrow it") or `unavailable`.
- **Routes:** `/v1/ramp/…`, each behind `read`. `--since` and `--until` become calendar days in the user's zone. Search text needs three characters (Ramp's minimum). New `external_refs` kinds and prefixes `txn_`, `rmb_`, `req_`, `bil_` (migration `ramp_refs`).
- **CLI:** `Resource.objects` adds one level (`winston ramp transactions list`). Help, "Did you mean" and `winston get` walk into it. Scope is the user's own, `--company` (admins) or `--to-approve`.
- **Gateway:** `RAMP_OAUTH_CLIENT_ID` turns Ramp on, with `rotatingAccessTokens` and Ramp's refresher. The gateway now has `kms:GenerateDataKey` (infra test and §13 updated), moved here from 52bf55.
- **Tests:**
  - The connector: normalization, the dropped agent messages, the error mapping, the feed, and getting a reimbursement by uuid.
  - The routes: ids stable across lists, dates in the user's zone, approvals' ids, no account, `read` off, the wrong kind of id, short search text, an expired grant, a missing scope.
  - The CLI: help and typos, list lines, short searches, approvals, `winston get txn_…`.
- **Not tested:** an employee's view against an admin's. Ramp decides what each role sees; `--company` only asks for it.
