# Working on Winston

These are the rules for how work happens in this repo. What Winston is and how it's built lives in `docs/`. Read the code and docs for that, not this file.

## Tickets

- Work comes from Moth tickets in `.moth/`, in the order given by `docs/plan.md`.
- Before starting a ticket, re-check it against the current docs and the tickets it depends on. If things have moved on, update the ticket first.
- If a ticket's instructions conflict with the principles below, raise it with the user instead of following the ticket as written.
- Claim a ticket by moving it to `in-progress`. Move it to `done` in the same commit as the work.
- One ticket per commit.

## Principles

- **Build for today, design for where we're going.**
  - Don't add helpers, stubs, config or infrastructure that the current ticket doesn't need. Speculative code is how tech debt starts.
  - Do think ahead about decisions that are hard to change later (architecture, data shapes, interfaces between parts), and write today's code in the direction the project is heading, so later commits build on it instead of overwriting it.
  - Deleting is fine when something no longer belongs.
- **Docs describe what's actually built.** When a decision or implementation changes, update `docs/` and the ticket in the same commit.
- **Research a new tool before configuring it:** how it works and is configured today, and how it fits with the existing stack and the tools already in the repo. Check current docs rather than relying on memory, because tools change fast.
- **Ask rather than guess on direction.** When a choice is ambiguous or hard to reverse, ask the user before deciding.
- **Some things need a human.** The invariants in `docs/design.md` Part 3 change only with a maintainer's agreement. Tickets labeled `collab` are done together with the user, not autonomously.
