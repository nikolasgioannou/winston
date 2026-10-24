---
id: "07ba81"
title: Fix what the Oct 1–16 trace audit found
status: todo
priority: none
labels:
  - agents
created_at: 2026-10-24T15:51:28.847Z
updated_at: 2026-10-24T16:50:57.023Z
---

The second production trace review, done with the founder on 2026-10-24. It covers every trace from go-live to 2026-10-16 14:00 UTC:
- 536 runs and 4,193 run messages
- 2,035 model calls, costing $91.33
- 542 messages sent

Each day was read end to end as a timeline. It follows the first review (5c3cdf, 2026-10-03), and several of that review's fixes have since regressed. Each agreed fix is a child of this ticket, with its evidence: times, run ids and quotes.

The full write-up isn't committed to the repo, because it quotes the founder's personal data.

**Decided with the founder:**
- **Chattiness:** narration and multi-message turns are back since b9305a9. The founder doesn't mind them for now, so there's no ticket.
- **Follow-through, for later:** promises with no trigger, a way for the front to defer a message, and a to-do / open-questions file.
- **The feed site's hourly "Do it" poll, for later:** 41 empty fires, about $1.80/day. Decide whether the feed stays before building site events.
- **Sensitive data:** passport, KTN and bank details in notes, briefs and trigger notes are fine (as in 5c3cdf).
- **Not filed:** the VM outage of Oct 2 (it hasn't come back). Also the Ramp browser failure of Oct 5, which is moot now that `winston ramp` uses Ramp's API.
