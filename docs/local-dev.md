# Local development

## First-time setup

1. Run `./scripts/setup.sh`. It installs everything, creates `.env.local` from `.env.example`, starts Postgres and reports anything that still needs you.
2. Fill in the `SEED_*` values in `.env.local` (the user you'll develop as), then re-run `./scripts/setup.sh` to seed them.
3. Set up your [webhook tunnel](#webhook-tunnel).

## Running

```bash
bun dev
```

`bun dev` starts Postgres and applies migrations, then runs `api`, `agents` and the tunnel together, with each line of output prefixed by its service. `api` and `agents` restart when any file they import changes, including shared packages. Ctrl-C stops everything, waiting for in-flight work like a deploy would, and a second Ctrl-C forces it. If the tunnel isn't set up, it reports that and the other services keep running.

Logs are human-readable in `bun dev` and in a terminal, and JSON lines otherwise. Set `LOG_PRETTY` in `.env.local` to force one or the other.

## Webhook tunnel

Telegram and Google push webhooks to a public HTTPS URL. Locally, a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gives the local `api` that URL. `bun dev` runs it, and `bun run tunnel` runs it on its own. The maintainer's tunnel is `winston-dev`, serving `https://dev.runwinston.com` (`runwinston.com` is on Cloudflare DNS).

To set up your own (a tunnel needs a domain whose DNS is on Cloudflare):

```bash
cloudflared tunnel login
cloudflared tunnel create <tunnel-name>
cloudflared tunnel route dns <tunnel-name> <hostname>
```

`login` opens a browser to authorize one domain. The certificate and tunnel credentials are saved in `~/.cloudflared/`, outside the repo; keep them private. Then set `TUNNEL_NAME` (and `TUNNEL_ORIGIN_URL` if the api isn't on port 3000) in `.env.local`.
