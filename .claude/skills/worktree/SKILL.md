---
name: worktree
description: Work on a ticket in an isolated git worktree, alongside other sessions, from setup through landing on main and cleanup. Use when the user asks to use a worktree or to work in parallel with another session.
---

# Working in a worktree

A worktree is its own checkout on its own branch, with its own databases and ports (docs/local-dev.md, Worktrees), so this session can't trip over another one. AGENTS.md applies as usual; only where the work happens and how it lands change.

## Start

1. Enter a new worktree with the `EnterWorktree` tool, named after the work (a few words, kebab-case). Skip this if the session is already in one (a desktop worktree session).
2. Run `bun run worktree setup`. It prints the worktree's ports; its site is the `site` URL, not localhost:3002.
3. For a preview, `.claude/launch.json` isn't in git: write one in the worktree whose `dev` configuration (`bun run dev`) uses the site's port.

## Work

- Work the ticket exactly as AGENTS.md says, committing on the worktree's branch. The pre-commit check runs against the worktree's own test database.
- Never `cd` into the main checkout or run git there: another session owns it.
- `bun dev` here has no webhook tunnel, so Telegram messages and Gmail or Calendar pushes don't reach it. Test those from the main checkout.
- Signing in goes through the OAuth relay on port 3003, which `bun dev` starts.

## Land

1. `git fetch origin`, then `git rebase origin/main`. Resolve conflicts, which are likely in `docs/` and `.moth/` if another session touched them.
2. If the rebase brought in new commits, run `bun run check` again.
3. Push the branch onto main: `git push origin HEAD:main`. It only fast-forwards; if it's rejected, main moved, so go back to step 1. Pushing doesn't deploy (that's a separate, manual step).
4. Tell the user main moved, so the main checkout needs `git pull --rebase --autostash` before its next commit.

## Clean up

1. Stop this worktree's `bun dev` if it's running.
2. Run `bun run worktree remove` to drop its databases and its local VM.
3. Leave and delete the worktree with `ExitWorktree` (`action: "remove"`). If the session didn't create it (a desktop worktree session), tell the user it can be archived instead.
