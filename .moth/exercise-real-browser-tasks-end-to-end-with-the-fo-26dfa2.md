---
id: "26dfa2"
title: Exercise real browser tasks end to end (with the founder)
status: todo
priority: none
labels:
  - browser
  - collab
  - m8
created_at: 2026-09-27T05:42:04.358Z
updated_at: 2026-09-27T05:42:04.414Z
blocked_by:
  - "3d5f3d"
  - "63475d"
---

Browser quality can't be unit-tested. It's judged on real tasks (docs/design.md §8b, Not tested automatically). With the founder, run a set of realistic tasks through production Winston and fix what breaks, filing follow-up tickets for anything larger than a quick fix:
- **Research and read:** compare three products' prices and report back.
- **Logged-in flow with a handoff:** a site that needs login. Winston hands off, the founder logs in **on their phone**, says "done", and Winston continues. Later, a second task on the same site needs no handoff, which checks that the profile persists.
- **Booking-style flow** up to (not past) the confirm step, with confirm-first honoured.
- **Parallel work:** two background tasks on different sites at once, plus a front-of-house peek. Also two tasks on the *same* site, to check domain lock behaviour.
- **Autopilot:** check that Jev is used on routine stretches, and look at the `jev_decisions` log. Compare speed with and without it.
- **Crash resilience:** restart Chrome mid-task and watch recovery.

Record observations in the docs: what worked, what didn't, memory use on the VM, and whether any sites block AWS IPs (the datacenter-IP risk in §Risks). Update the Risks section with real findings.
