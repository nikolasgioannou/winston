---
id: "6905aa"
title: Trigger reports that need nothing still cost a front-of-house turn
status: todo
priority: medium
labels:
  - agents
  - costs
parent: "07ba81"
created_at: 2026-10-24T16:49:56.815Z
updated_at: 2026-10-24T16:50:33.400Z
---

Every trigger run's report wakes the front of house, even when the report is exactly "Nothing needs the user's attention.". The front then only calls `end_turn`. After an idle gap that turn is a full cache write.

**From the trace audit (07ba81):**

- Since Oct 4, front-of-house cache misses cost $28 of $53.
  - 45 misses ($21) came after gaps of more than an hour, which is expected with the 1-hour TTL (93c46b). Many of those were relays of empty trigger reports, at $0.37–0.60 each.
  - 16 misses ($7) came within the hour, so something breaks the cached prefix. The audit saw this after interrupted turns ("Your last message was not sent… new messages arrived"). Examples: Oct 8 20:02:51, cold 13 seconds after the previous run; Oct 3 16:27, one minute after a $0.069 turn.
- On Oct 14–16, the hourly feed poll plus its relays were 59% of spend.

**What to build**

- A background run started by a trigger whose report is exactly "Nothing needs the user's attention." doesn't start a front-of-house run. The report stays in history, so `winston history` still finds it.
- Find what breaks the cache within the hour (start with history rewritten after an interrupted step) and fix it.

**Done when**

- [ ] An empty trigger report creates no front run (test)
- [ ] An interrupted turn followed by another within minutes reads from the cache (verified against OpenRouter, as in 93c46b)
- [ ] docs/design.md (cost section) updated
