# Local development

Start with `./scripts/setup.sh`. It gets the repo working and reports anything that still needs you.

## Webhook tunnel

Telegram and Google push webhooks to a public HTTPS URL. Locally, a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gives the local `api` that URL, and `bun run tunnel` runs it. The maintainer's tunnel is `winston-dev`, serving `https://dev.runwinston.com` (`runwinston.com` is on Cloudflare DNS).

To set up your own (a tunnel needs a domain whose DNS is on Cloudflare):

```bash
cloudflared tunnel login
cloudflared tunnel create <tunnel-name>
cloudflared tunnel route dns <tunnel-name> <hostname>
```

`login` opens a browser to authorize one domain. The certificate and tunnel credentials are saved in `~/.cloudflared/`, outside the repo; keep them private. Then set `TUNNEL_NAME` (and `TUNNEL_ORIGIN_URL` if the api isn't on port 3000) in `.env.local`.
