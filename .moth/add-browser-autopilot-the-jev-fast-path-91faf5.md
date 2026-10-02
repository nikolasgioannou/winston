---
id: "91faf5"
title: Add browser autopilot, the Jev fast path
status: done
priority: none
labels:
  - browser
  - cli
  - m8
created_at: 2026-09-27T05:42:04.154Z
updated_at: 2026-10-02T16:47:42.173Z
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

## As built

- **Where:** in `winstond` (`browser/autopilot.ts`, `POST /v1/browser/autopilot`), which holds the browser and calls the Jev routes through the gateway; the CLI command just asks it. One Jev call per step: `action` (choice among the snapshot's refs, ≤255, labelled as the snapshot shows them), `goal_done` and `stuck` (nouls).
- **Stops:** P(goal met) ≥ 0.85; P(stuck) ≥ 0.7 from step 3 (as `jev-browser` does, it ignores stuck at first); the pick's probability < 0.5; the pick is a typing role; the pick commits something (button/link/menu item names like place order, buy, pay, confirm, submit, send, book, delete, cancel, subscribe, sign up, agree, save, sign out…; "Checkout" alone doesn't count); a failed click; `--max-steps` (default 8, max 20). Output: clicks, stop code and reason, URL, "Snapshot next."
- **Outcome signal (the research question):** the same run's next acting command after autopilot clicked: `navigate --back` → `overridden`, anything else → `verified`, recorded through `POST /v1/jev/outcome` (own decisions only). Recorded in §5.
- **Per-site disable:** `GET /v1/jev/sites/:domain` (eTLD+1): last 30 decided picks across users; off once ≥ 6 are known and more than half were overridden.
- Checked live on the local VM with real Jev on Hacker News: the top story's comments in 1.8 s, `goal_met`; going back marked both picks overridden.
- Tests with a fake Jev: every stop condition, the commit heuristics, step limits, the unreliable site, Jev down, outcome judging; backend tests for outcomes (own decisions only) and the reliability rule.
