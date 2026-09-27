---
id: "16c290"
title: Decide and set up the local webhook tunnel (with the founder)
status: todo
priority: none
labels:
  - collab
  - m1
  - tooling
created_at: 2026-09-27T05:30:53.925Z
updated_at: 2026-09-27T05:30:53.956Z
blocked_by:
  - "0fa82e"
---

Local development relies on a tunnel so Telegram, Google Pub/Sub and Calendar can push webhooks to a laptop exactly as they would in production (docs/design.md §8a). The design says "Cloudflare Tunnel with a stable URL like `dev.runwinston.com`", but that has a catch to resolve with the founder before building on it.

A **named** Cloudflare Tunnel with a public hostname requires the hostname's DNS zone to be on Cloudflare. The design currently puts `runwinston.com` DNS in Route 53 (§8, §19). Research and lay out the options with their trade-offs:
- Move `runwinston.com` DNS to Cloudflare entirely. CDK then manages records through Cloudflare, or leaves DNS to Cloudflare and uses ACM DNS validation there.
- Keep Route 53 for production and use a *separate* cheap domain on Cloudflare just for dev.
- Use ngrok's free static domain instead of Cloudflare.
- Cloudflare quick tunnels (random URL on every run), with a script that re-registers the Telegram webhook, Pub/Sub push endpoint and Calendar channels on each start. Probably too fragile for Pub/Sub.

Walk through these with the founder and let them decide. Then implement the chosen option:
- Pin the tunnel binary with mise where possible (no global installs).
- Write the credentials and setup steps into `docs/local-dev.md`.
- Expose the stable public base URL as a config value (`PUBLIC_WEBHOOK_BASE_URL`).

Update docs/design.md §8a (and §8/§19 if DNS moves) to match the decision. Done when a request to the public URL reaches a trivial local HTTP server.
