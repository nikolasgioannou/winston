---
id: "91faf5"
title: Add browser autopilot, the Jev fast path
status: todo
priority: none
labels:
  - browser
  - cli
  - m8
created_at: 2026-09-27T05:42:04.154Z
updated_at: 2026-09-27T05:42:04.230Z
blocked_by:
  - "0451df"
  - "17f478"
  - "b782bc"
---

`winston browser autopilot "<subgoal>" [--max-steps <n>]` hands routine clicking to Jev: "get to the checkout page", "open the first result" (docs/design.md §5 Browser, Jev fast path). Opus decides when to use it. Autopilot runs until the sub-goal is met or it should hand back, then reports what it did.

The loop:
1. Snapshot the page.
2. Ask Jev three typed questions: **which element to act on** (a choice among snapshot refs, limited to 255), **P(sub-goal met)** and **P(stuck)**.
3. If Jev is confident in an element, act (click, select, press), and repeat.

Stop and hand back to Opus when any of these happen:
- The confidence is low.
- P(stuck) rises.
- **Text needs typing** (Jev can't type).
- **The next step looks like it commits something** (submit, buy, send, confirm). Research heuristics from element roles and names, and make them conservative.
- P(sub-goal met) is high.
- `--max-steps` is reached.

Output: the actions taken, why it stopped, and the current URL. Suggest a snapshot next.

**Per-site reliability:** record each autopilot run's decisions and a final outcome. Decide how the outcome is known (for example, Opus's next action in that window either continues from where autopilot stopped, or navigates back), research a workable signal, and record the choice in §5. Use it to turn autopilot off for sites where Jev keeps getting overridden: `autopilot` then returns immediately with "not reliable on this site; drive it directly."

Tests with a fake Jev: each stop condition, the commit-action heuristics, step limits, and the per-site disable logic.
