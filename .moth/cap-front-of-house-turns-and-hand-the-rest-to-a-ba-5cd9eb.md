---
id: "5cd9eb"
title: Cap front-of-house turns and hand the rest to a background agent
status: todo
priority: none
labels:
  - agents
  - m6
created_at: 2026-09-27T05:38:50.112Z
updated_at: 2026-09-27T05:38:50.147Z
blocked_by:
  - "438b86"
---

The front of house can do anything a background agent can, but it must stay responsive (docs/design.md §1, Same capabilities). If it misjudges how long something takes, a per-turn **step budget of ~15** stops it and **delegates the remainder**.

Implement:
- When a front-of-house turn reaches its budget, stop the loop. Automatically create a background run whose brief is generated from the turn so far: the goal as understood, what's been done, the current state, and what's left. Research the cleanest way to produce that brief: a small summarization call on the front-of-house model, or asking the model to call `delegate` itself on its final allowed step. Pick one and justify it.
- Send the user a short note that it's continuing in the background. Use the fixed wording from §1 or let the model phrase it. Prefer the model if the chosen approach makes that natural.
- **Image pruning in the front-of-house window:** screenshots older than the current turn become text stubs (`[screenshot of opentable.com, pruned]`), keeping the rolling window mostly conversation (§1, §16).

Tests with the fake model: the budget boundary produces a delegated run with a coherent brief and a user note, turns under budget are unaffected, and old images are stubbed while the current turn's stay.
