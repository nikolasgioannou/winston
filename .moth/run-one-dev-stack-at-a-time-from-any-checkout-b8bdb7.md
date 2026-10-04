---
id: "b8bdb7"
title: Run one dev stack at a time, from any checkout
status: done
priority: medium
labels:
  - tooling
created_at: 2026-10-04T01:34:52.487Z
updated_at: 2026-10-04T01:35:02.374Z
---

063b62 gave each worktree its own dev stack on its own ports, with a local OAuth relay for Google sign-in. Webhooks still reached only the main checkout (one bot webhook, one tunnel), so a worktree's stack half worked, which the founder found confusing. Replace it with a simple rule: **one dev stack at a time, from any checkout.**

- Every checkout uses the normal ports (3000–3002), the tunnel and the 3002 redirect URIs, so whichever runs `bun dev` gets everything, Telegram and Google pushes included.
- `bun dev` refuses to start while another checkout's stack holds its ports, before a second tunnel connector could split webhooks.
- Worktrees keep their own databases (setup and teardown stay).
- Remove the port slots, the OAuth relay, `GOOGLE_OAUTH_REDIRECT_URL` and the per-port session cookie name.
- The `worktree` skill lands only when the founder says so.

Founder steps: add the two `http://localhost:3002/...` redirect URIs back to the `Winston dev` client before this lands, and remove the two `3003` ones after.

## Outcome

Built as described; docs/local-dev.md (Worktrees) and docs/design.md §8a describe it. The relay's code, Compose service and Dockerfile are gone, and the site, Vite config, `.env.example`, `setup.sh` and the Google runbook are back to how they were before 063b62. Kept from 063b62: the worktree databases, `bun dev` leaving the tunnel out without `TUNNEL_NAME`, and the ignores for `.claude/worktrees/`.

- **`bun run worktree setup` now rebuilds the worktree's `.env.local` from the main checkout's** every run, with only the two database URLs changed. That also repairs worktrees set up by 063b62 (whose port block had replaced the tunnel name) and picks up new settings from the main checkout.
- **The port check** connects to the api, gateway and site ports on 127.0.0.1 and ::1 (Vite listens on ::1).
- **Stopped checkouts' VMs** aren't stopped: the running gateway answers their reconnects with a 401, which they retry quietly every 30 s or so.
- `.env.local` files that `setup.sh` gave `GOOGLE_OAUTH_REDIRECT_URL` keep the line; nothing reads it, so it can be deleted.

Checked in a worktree while the main checkout's stack ran: setup (including over a 063b62-era `.env.local`, restoring its tunnel name), `bun dev` refusing with the port in use, and `bun run check`.
