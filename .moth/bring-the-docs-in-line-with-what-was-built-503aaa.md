---
id: "503aaa"
title: Bring the docs in line with what was built
status: done
priority: none
labels:
  - docs
  - m9
created_at: 2026-09-27T05:42:36.421Z
updated_at: 2026-10-02T18:43:55.486Z
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

## As built

An end-to-end audit on 2026-10-02: four read-only passes compared docs/design.md (§1–§6, §7–§13, §14–end) and product.md, plan.md, the runbooks, local-dev.md and testing.md against the code, each finding with file:line evidence; the design fixes were then applied section by section, re-checking each against the code (one finding turned out wrong and was skipped).

- **design.md:** about 85 corrections, among them: background runs as one call per `run_step` job with `maxStepsPerRun`; the six front-of-house tools; Jev latency, opt-out site reliability and winstond (not the CLI) calling it; `system.handoff.done` in the always-delivered events; filter field names as the CLI spells them; the monorepo's real apps and packages and libraries; automatic AMI builds and rollouts; gateway routing via `vms.gateway_url`; the full CLI reference (me, task update/link, browser get/dialog/list, `--window`, mail/calendar flags); §14 columns (`vms.image_id`, `gateway_url`, `state_changed_at`, `handoffs.viewer_secret_hash`, outbound files), the real job types; every frame in §15 including the desktop ones; `/v1` routes and the internal API; state-machine details (`updating` unused, lease renewal); the image's three units and EC2-only swap/upgrades; KMS grants, `TOKEN_KMS_KEY_ID`, security groups and ECR including `ops`; stale decisions (#46, #71) and risks (Bun under Rosetta resolved, event-run cost).
- **Invariants:** all 11 checked and still true; none changed.
- **product.md:** status, page names, Done on the live view, the full desktop, spend controls; open questions answered (Chrome memory, Jev via OpenRouter, mobile handoff) and datacenter-IP blocking added.
- **plan.md:** manual deploys, 161 tickets / 13 collaborative (b782bc lost its `collab` label when the founder step went away), a truncated title, f6b5a6's blocker, milestone summaries for the tickets added along the way.
- **Runbooks:** production.md gained `vm:restore`/`vm:roll`/`costs`, logs, what production runs (including image-level features needing a roll), shell access through Session Manager, and links to the rest; secrets (the OpenRouter key's second reader, the webhook command), costs (current limits, Jev under OpenRouter), DNS (live records), VM recovery (automatic rolls, the wedged-but-current gap, older snapshots, the pending restore drill), AWS access, deploys (`ami.yml`), local-dev's extensions. `.env.example` gained `BACKGROUND_CONCURRENCY`; the ops usage line lists every command.
