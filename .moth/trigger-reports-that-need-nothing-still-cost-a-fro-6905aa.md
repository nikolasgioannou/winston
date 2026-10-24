---
id: "6905aa"
title: Trigger reports that need nothing still cost a front-of-house turn
status: done
priority: medium
labels:
  - agents
  - costs
parent: "07ba81"
created_at: 2026-10-24T16:49:56.815Z
updated_at: 2026-10-24T19:37:23.737Z
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

## As built, part one (2026-10-24)

- `finishTask` (`@winston/db/tasks`) records the report of a completed trigger run as already seen by that run when it says nothing needs the user (`nothingForUser`, ignoring case and the full stop). It does this through `recordSystemEvent(…, { seenBy })`. The report stays in `inbound_items`, so history still finds it, but no front-of-house turn is queued.
- Delegated tasks, failures, caps and cancels always reach the front.
- Test (`trigger-run.test.ts`): a "nothing" report is consumed by its run with no turn queued, and a real report is unconsumed with a turn queued.
- docs/design.md (triggers, as built) updated.

**Not done yet:** finding what breaks the prompt cache within the hour (16 misses, $7). It needs paid measurement against OpenRouter, as in 93c46b, and the dev key is out of credit.

- [x] An empty trigger report creates no front run (test)
- [ ] An interrupted turn followed by another within minutes reads from the cache: waiting on credit
- [x] docs/design.md (cost section) updated: recorded under triggers, where the behavior lives

## As built, part two (2026-10-24)

What breaks the cache within the hour was measured from production `model_calls` (front runs, Oct 4–16): context window start, stub boundary and prompt hash, compared with the previous call. There were 11 cold first calls less than an hour after the previous call:

- **5 after the window's start moved:** the FIFO window sliding, by design.
- **3 after a deploy changed the prompt.**
- **3 after a turn that showed an image.** `storableMessage` stores tool-result images as a text stub, and user photos are stubbed the same way, so the next turn's history no longer matches the cache from there on. Each of those calls read only the system prompt and tools from cache (9,479 tokens) right after the previous turn had cached 135–144k. That's about $1.35 over two weeks.

None came from interrupted turns: the Oct 8 "cold 13 seconds later" case followed the dinner screenshot. The image case is left as it is, since the fix (keep images until they're behind the stub boundary) is a refactor for little money. It's recorded in docs/design.md under the cache lifetime.

- [x] An interrupted turn followed by another within minutes reads from the cache: interruptions weren't a cause (see above); no change needed
