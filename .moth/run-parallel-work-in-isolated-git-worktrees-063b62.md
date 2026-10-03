---
id: "063b62"
title: Run parallel work in isolated git worktrees
status: done
priority: medium
labels:
  - tooling
created_at: 2026-10-03T23:43:32.529Z
updated_at: 2026-10-03T23:49:08.914Z
---

The founder runs several agent sessions at once. Each should be able to work in its own git worktree, with nothing shared that two sessions could break for each other, and "use a worktree" should be the whole instruction.

Claude Code already creates worktrees (`EnterWorktree`, the desktop app's worktree sessions) under `.claude/worktrees/<name>/` on their own branch, and removes them on exit. Winston needs the rest:

- **Setup** (`bun run worktree setup`, safe to re-run): copies `.env.local` from the main checkout if it's missing; picks a free port slot and gives the worktree its own databases (`winston_<name>`, `winston_<name>_test`) and ports in its `.env.local`; turns the tunnel off there (only the main checkout receives webhooks); installs dependencies; creates, migrates and seeds its database.
- **Teardown** (`bun run worktree remove`): drops the worktree's databases and removes its local VM containers and volumes, before the worktree itself is removed.
- **Ports:** slot n (1–9) uses api 30n0, gateway 30n1, web 30n2; the main checkout keeps 3000–3002. The web dev server reads its port from `WEB_PUBLIC_URL`.
- **Google sign-in through a local OAuth relay:** Google only redirects to registered URIs. A tiny relay on `localhost:3003` (a docker-compose service next to Postgres, so `bun dev` starts it if it isn't running and every checkout shares it) is registered on the dev client once. A worktree's site sends Google there (`GOOGLE_OAUTH_REDIRECT_URL`) and leaves a cookie naming its own origin; cookies ignore ports, so the relay reads it and sends the browser on to the worktree's callback. It only redirects to `http://localhost:<port>`. The main checkout keeps redirecting straight to 3002 and doesn't need the relay. (Changed while building: every checkout goes through the relay; see Outcome.)
- **Tooling ignores worktrees:** `.claude/worktrees/` in `.gitignore` and ESLint's ignores (ESLint otherwise lints them from the main checkout; bun test already skips hidden folders).
- **A `worktree` skill** (`.claude/skills/worktree/`): enter a worktree, run setup, work the ticket as usual, then rebase onto `main`, fast-forward `main`, run teardown and remove the worktree.

Founder step: add `http://localhost:3003/auth/google/callback` and `http://localhost:3003/auth/google/connect/callback` to the `Winston dev` client (docs/runbooks/google-cloud.md).

Rejected: registering a redirect URI per worktree port (console work for every slot and path), and copying the main dev database into each worktree to skip sign-in (its VM rows would point at the main checkout's VM container).

Done when a second worktree can run `bun run check` and `bun dev` alongside the main checkout without touching its databases or ports, and signing in and connecting Google work there through the relay. Document it in docs/local-dev.md and docs/design.md §8a.

## Outcome

Built as described; details in docs/local-dev.md (Worktrees) and docs/design.md §8a. Beyond the plan:

- **Session cookies are named for their port** locally (`winston_session_<port>`), since every checkout's site shares `localhost`: otherwise signing in to a worktree signed the main checkout out. The main checkout's site signs in again once.
- **`bun run worktree` runs with `--no-env-file`:** Bun loads `.env.local` before the script rewrites it, and commands it starts inherit those values over their own `--env-file`, which would have migrated the main database.
- **Every local checkout signs in through the relay,** the main one included, so there's one local path and the relay stays in daily use. `GOOGLE_OAUTH_REDIRECT_URL` is in `.env.example`, `setup.sh` adds it to older `.env.local` files, and the dev client needs only the relay's two URIs (the founder registered them; the old 3002 ones can go once the main checkout has re-run `setup.sh`). Production leaves it unset and is unchanged. The worktree script still writes it, so a worktree works even if the main checkout's `.env.local` predates it.
- **`bun dev` leaves the tunnel out without `TUNNEL_NAME`** instead of crashing it, and starts the relay when `GOOGLE_OAUTH_REDIRECT_URL` is set. Compose builds the relay (`pull_policy: build`) and reports it `Running` when another checkout already started it.
- **No `.worktreeinclude`:** setup copies `.env.local` itself, which works however the worktree was made.
- **Landing:** the main checkout's `main` can't be moved from a worktree without touching another session's files, so the skill rebases onto `origin/main` and pushes `HEAD:main`; the main checkout pulls before its next commit.

Checked in this worktree (slot 1) with the main checkout's Postgres and VM running: setup and a re-run, `bun run check` on `winston_worktree_dev_test`, `bun dev` on 3010–3012 with the relay built and its own VM registered, the sign-in start redirecting to Google with the relay's redirect URI and the return cookie, the relay forwarding a callback to 3012 (and refusing other origins), and `worktree remove` dropping both databases and the worktree's VM while leaving the main checkout's. Not yet checked: a real Google sign-in through the relay (the URIs are now registered).
