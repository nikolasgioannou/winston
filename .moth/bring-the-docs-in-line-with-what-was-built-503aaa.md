---
id: "503aaa"
title: Bring the docs in line with what was built
status: todo
priority: none
labels:
  - docs
  - m9
created_at: 2026-09-27T05:42:36.421Z
updated_at: 2026-09-27T05:42:36.477Z
blocked_by:
  - "46ee9b"
  - "62e3d2"
---

The rule throughout was "update the docs in the same commit when reality diverges", but some drift is inevitable over this many tickets. This ticket is a deliberate end-to-end pass over `docs/product.md`, `docs/design.md` and `docs/plan.md` against the actual code:
- For each section of the design doc, confirm it describes what exists. Fix anything that drifted, especially Part 3's sketch details (table shapes, frame names, thresholds, stack boundaries), which were expected to change.
- Re-check the **invariants list**. If any invariant was changed along the way with the founder, make sure the list and the decision log reflect it.
- Update the product doc's **open questions**: resolve the ones answered in practice (Chrome memory on 4 GB, Jev access, the work account, mobile handoff quality) with what was learned.
- Update **Risks & flags** with real findings, such as datacenter-IP blocking.
- Make sure the runbooks in `docs/runbooks/` cover everything needed to operate Winston: deploys, recovery, secrets, access, costs, GCP, DNS.

Done when someone new could read the docs and get an accurate picture of the system.
