# Working on Winston

These are the rules for how work happens in this repo. What Winston is and how it's built lives in `docs/`. Read the code and docs for that, not this file.

## Tickets

- Work comes from Moth tickets in `.moth/`: the ones the founder asks for, or else the next unblocked one. How to write, find, claim and close tickets is the `moth-method` skill; what follows is specific to this repo.
- Tickets labeled `spec` need a spec with the founder before any building.
- Re-check a ticket against the current docs as well as the code before starting it.
- If a ticket's instructions conflict with the principles below, raise it with the user instead of following the ticket as written.
- Group new milestones and features as parent tickets. Existing tickets are grouped by milestone labels (`m0`, `m1`, …) and stay that way.
- When asked to use a worktree (to work alongside other sessions), follow the `worktree` skill.

## Principles

- **Build for today, design for where we're going.**
  - Don't add helpers, stubs, config or infrastructure that the current ticket doesn't need. Speculative code is how tech debt starts.
  - Do think ahead about decisions that are hard to change later (architecture, data shapes, interfaces between parts), and write today's code in the direction the project is heading, so later commits build on it instead of overwriting it.
  - Deleting is fine when something no longer belongs.
- **Docs describe what's actually built.** When a decision or implementation changes, update `docs/` and the ticket in the same commit.
- **Keep `scripts/setup.sh` complete.** If a change adds something contributors must set up, extend `scripts/setup.sh` (check first, then act, so it stays safe to re-run).
- **Keep the editor setup current.** When a change adds or changes a tool, update `.vscode/extensions.json` and `.vscode/settings.json` in the same commit if it affects them.
- **Research a new tool before configuring it:** how it works and is configured today, and how it fits with the existing stack and the tools already in the repo. Check current docs rather than relying on memory, because tools change fast.
- **Ask rather than guess on direction.** When a choice is ambiguous or hard to reverse, ask the user before deciding.
- **Some things need a human.** The invariants in `docs/design.md` Part 3 change only with a maintainer's agreement. Tickets labeled `collab` are done together with the user, not autonomously.
