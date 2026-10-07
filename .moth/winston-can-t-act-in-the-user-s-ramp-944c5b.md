---
id: "944c5b"
title: Winston can't act in the user's Ramp
status: in-progress
priority: none
labels:
  - backend
  - cli
  - connectors
parent: "80fcf0"
created_at: 2026-10-05T23:01:37.516Z
updated_at: 2026-10-07T15:50:47.108Z
blocked_by:
  - "02441f"
---

The write side of `winston ramp` (80fcf0), built like Gmail's writes (837a29, d66d10): each verb behind its capability, `--dry-run` everywhere, and every real write audited.

**What to build**

- **`edit`:** `transactions update <txn_id>` (`--memo`, `--category`/coding, `--trip`, `--comment`) and `reimbursements update <rmb_id>` (the fields Ramp's tool allows).
- **`submit`:** `reimbursements submit <rmb_id>`, for the user's own drafts. Creating a reimbursement from a receipt is out of scope: MCP takes no files.
- **`approve`:** `approve` and `reject` (`--note`, required for reject if Ramp requires it) on `transactions`, `reimbursements` and `requests`, only for items waiting on the user.
- **Dry runs** run the same capability checks and return exactly what would happen (the item, its amount and submitter, the change or decision), and nothing is sent to Ramp, so a disabled capability is caught before the user is asked to confirm.
- **Audit:** every real write goes through `audited` (`ramp.transaction.update`, `ramp.reimbursement.submit`, `ramp.approve`, `ramp.reject`, …) with Ramp's id as `result_ref`.
- Writes print what changed, as mail and calendar writes do.

**Done when**

- [x] vm-api tests for each verb: capability off, dry run, real call audited, Ramp's error (already approved, not the approver) mapped to a clear message
- [ ] Locally, against the founder's Ramp: a memo edited, and a request approved with `--dry-run` first
- [x] `design.md` §5 and §11 describe the write routes and commands; `product.md` §4 and §6 list what Winston can do in Ramp


## As built (waiting on the founder's local check)

- **Provider methods** (`@winston/connectors/ramp`): `setMemo`, `comment`, `submitReimbursement` and `decide`, calling `ramp_edit_transaction`, `ramp_edit_reimbursement`, `ramp_post_comment`, `ramp_submit_reimbursement` and `ramp_approve_or_reject_{transaction,reimbursement,request}`. Their inputs come from Ramp's agent-tools spec, since the spike only had read scopes.
  - **Approving and rejecting:** Ramp's own action words. The user's `--note` goes as `user_reason`. Rejecting a transaction is `REJECT_AND_REQUEST_CHANGES` and needs a note; full repayment isn't offered.
  - **Memos:** marked `user_submitted_fields: ["memo"]`.
- **Routes** (`ramp-write.ts`): explicit paths per object, so the CLI's typed client sees each one. Each checks its capability (and the granted scopes) first, `dryRun` shows the object and the change, and real writes go through `audited` with the CLI id as `target_ref`.
- **CLI:** `update` (`--memo`, `--comment`), `submit`, `approve` and `reject` (`--note`), all with `--dry-run`. Writes print `Approved Uber $42.50 from Ada Lovelace (txn_…).`, or `DRY RUN (nothing changed) · would approve …`. Hono's client methods are proxies, so they're called through closures.
- **Narrower than planned:** accounting codes and trips on `update` aren't built. Setting them needs Ramp's category, option and trip lookups first; worth a ticket if the founder wants them.
- **Docs:** `product.md` §6 (confirm-first for Ramp) comes with the prompts (17254b).
- **Tests:** the routes (capability off, a missing scope refused before Ramp is asked, a dry run calling nothing, an audited approve, a reject needing a note, `edit` and `submit` kept apart, the wrong kind of id); the connector (action words, memo fields, comment types, Ramp's refusal passed on); the CLI (dry-run line, an update with nothing to change).
