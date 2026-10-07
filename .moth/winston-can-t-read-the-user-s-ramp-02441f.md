---
id: "02441f"
title: Winston can't read the user's Ramp
status: todo
priority: none
labels:
  - backend
  - cli
  - connectors
parent: "80fcf0"
created_at: 2026-10-05T23:01:23.152Z
updated_at: 2026-10-07T15:04:20.573Z
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

- [ ] Tests against the spike's synthetic fixtures: the normalization of each object, paging, the 100-row error, and an employee's view against an admin's
- [ ] vm-api tests: `read` off is `permission_disabled` with the link, an expired grant is `auth_expired`
- [ ] Locally, against the founder's Ramp, `winston ramp approvals list` and `winston ramp transactions search` give the expected results
- [ ] `design.md` §11 (command reference, the provider-named exception, sub-resources) and §5 describe what's built (decision #81 already records provider naming)


**Added 2026-10-06 (from 52bf55):** the gateway is the first service to refresh Ramp's rotating tokens, so this ticket grants it `kms:GenerateDataKey` on the tokens key (`infra/src/services.ts`; its test currently asserts the gateway never seals, and `design.md` §13 and §19 say so). 52bf55 left the grant out because nothing used it yet.


**From the spike (aa06d1, 2026-10-07):** the tool names, shapes and paging are in the "Verified" section of `docs/research/ramp-mcp.md`. Amounts are display strings (`$12.34`) beside `original_amount` and `original_currency`, so parse them. `ramp_get_attention_feed` already groups what's waiting on the user by section, which is `approvals list`. `ramp_get_requests_to_review` requires a `thoughts` argument.
