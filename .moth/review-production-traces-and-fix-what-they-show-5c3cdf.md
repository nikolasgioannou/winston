---
id: "5c3cdf"
title: Review production traces and fix what they show
status: done
priority: none
labels:
  - agents
  - collab
  - spec
created_at: 2026-10-03T16:31:57.452Z
updated_at: 2026-10-03T17:26:27.826Z
---

**Collaborative.** The founder has used production Winston daily since go-live and seen him make mistakes and fail at things. Go through the production traces together and turn what they show into fixes.

- **The record:** what the database already has: model calls, `run_messages` (every step and tool call), inbound and outbound messages, background runs and their reports, trigger runs, handoffs, Jev decisions, the audit log and the cost ledger. `winston history` and `bun run prod costs` help navigate it.
- **Access:** production data is the founder's own conversations. Read it with them, or with their explicit go-ahead for this review (an earlier attempt to read it unprompted was rightly blocked).
- **What to look for:**
  - the mistakes and failures the founder remembers (collect a list from them first);
  - wrong or missing actions;
  - confirm-first slips;
  - promises without a trigger;
  - chattiness or silence at the wrong time;
  - weak briefs and wasted browser steps;
  - errors in the logs;
  - expensive runs.
- **Output:** small fixes (prompts, tool descriptions, bugs) done in this ticket; anything larger becomes its own ticket.
- Record what changed and why in docs/design.md, as the first prompt review did (62e3d2).


## As built

Reviewed with the founder on 2026-10-03, with their go-ahead to read production. The whole record from go-live to then: 85 inbound items, 105 replies, 85 runs (3 background), 593 run messages, 294 model calls ($9.82). Read end to end as a timeline of messages, tool calls and results.

**What went well:** fixing the flight calendar, saving passport and TSA details, an honest check-in report when BA blocked it, finding the fireside-chat briefing, and many calendar changes without a slip.

**The findings became tickets:**
- **ea2e27, real-world mistakes,** fixed by principle rather than per-case rules, with replays of real failures as the test: a drive time from the wrong moment, a fan post over the founder's email, stale emails over the calendar, a slot already past, promises without triggers.
- **b8e28a, the live view on a signed-in page:** watch live, take over in place, and no more chat messages killing the link.
- **6abd9d, the browser fast path rebuilt on jev-ultrafast's loop,** including the closed-shadow-root "covered" bug and the front's 10-second limit.
- **dfe034, browser windows across runs:** finished tasks keep stale locks, tasks can't take over the front's window, and blank windows get handed over.
- **feebd3, less chattiness:** interim text becomes an ephemeral status.
- **e19be9, CLI times:** ISO 8601 instead of a phrase grammar, the weekday in envelopes, `calendar free` never in the past, and a kept-length notice.
- **93c46b, front-of-house cost and latency:** a 1-hour cache, a lighter window, a timeout that didn't stop 123-second calls, and the cache-marker limit.

**Fixed before the review:** "I can't browse the web" (152), connect-link instructions (75846c), calendar `invalid_client`, "computer unreachable" (f6b5a6 and the gateway-address fix), and table and dollar-sign rendering.

**Dropped (the founder's call):** passport and KTN details copied into trigger notes and briefs, which they're fine with.
