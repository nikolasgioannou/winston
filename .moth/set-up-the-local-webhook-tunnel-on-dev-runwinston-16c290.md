---
id: "16c290"
title: Set up the local webhook tunnel on dev.runwinston.com (with the founder)
status: done
priority: none
labels:
  - collab
  - m1
  - tooling
created_at: 2026-09-27T05:30:53.925Z
updated_at: 2026-09-27T18:37:16.848Z
blocked_by:
  - "0fa82e"
---

Local development relies on a tunnel so Telegram, Google Pub/Sub and Calendar can push webhooks to a laptop exactly as they would in production (docs/design.md §8a). Decided with the founder:
- **`runwinston.com` is registered with Cloudflare Registrar**, in a Cloudflare account dedicated to Winston, so its DNS is on Cloudflare. (A second Cloudflare account wasn't possible yet: new logins wait 7 days. So the sign-up account became Winston's, and future projects get their own accounts.)
- **A named Cloudflare Tunnel `winston-dev`** serves `https://dev.runwinston.com`.
- Rejected: a separate dev domain, ngrok's free static domain, and quick tunnels (random URLs are too fragile for Google's registered push endpoints).
- Production DNS moves from Route 53 to Cloudflare, so the M4 DNS ticket (`f92c63`) is updated to match.

Delivered:
- `cloudflared` pinned in `mise.toml`, logged in to the `runwinston.com` zone, the tunnel created and routed. Credentials are in `~/.cloudflared/`, outside the repo.
- `bun run tunnel` (`scripts/tunnel.ts`, with `TUNNEL_NAME` and `TUNNEL_ORIGIN_URL` validated through the config loader, listed in `.env.example`).
- The root `tsconfig.json` covers `scripts/`.
- `scripts/setup.sh` checks that the configured tunnel exists, as a hint rather than a failure.
- `docs/local-dev.md` covers setting up a tunnel.

`PUBLIC_WEBHOOK_BASE_URL` is added by the Telegram webhook ticket, the first code that needs it.

Verified: with the tunnel running, `GET` and `POST` requests to `https://dev.runwinston.com` reach a local server on port 3000 over valid HTTPS.
