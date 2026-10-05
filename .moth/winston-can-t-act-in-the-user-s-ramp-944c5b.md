---
id: "944c5b"
title: Winston can't act in the user's Ramp
status: todo
priority: none
labels:
  - backend
  - cli
  - connectors
parent: "80fcf0"
created_at: 2026-10-05T23:01:37.516Z
updated_at: 2026-10-05T23:01:42.183Z
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

- [ ] vm-api tests for each verb: capability off, dry run, real call audited, Ramp's error (already approved, not the approver) mapped to a clear message
- [ ] Locally, against the founder's Ramp: a memo edited, and a request approved with `--dry-run` first
- [ ] `design.md` §5 and §11 describe the write routes and commands; `product.md` §4 and §6 list what Winston can do in Ramp
