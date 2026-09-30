# Local development

## First-time setup

1. Run `./scripts/setup.sh`. It installs everything, creates `.env.local` from `.env.example`, starts Postgres and reports anything that still needs you.
2. Fill in the `SEED_*` values in `.env.local` (the user you'll develop as), leaving `SEED_TELEGRAM_CHAT_ID` blank for now, then re-run `./scripts/setup.sh` to seed them.
3. Set up your [webhook tunnel](#webhook-tunnel).
4. Set up your [Telegram dev bot](#telegram-dev-bot), which includes linking your chat.

## Editor

The repo includes VS Code settings (`.vscode/`). Open the folder and accept the recommended extensions: ESLint, Prettier, Tailwind CSS IntelliSense and HashiCorp HCL. Files are formatted with the repo's Prettier on save, ESLint fixes apply when you save explicitly, and TypeScript uses the repo's version (accept the prompt to use the workspace version). Theme, font and other personal preferences stay in your user settings.

## Running

```bash
bun dev
```

`bun dev` starts Postgres and applies migrations, then runs `api`, `agents`, `gateway`, the site (`web`, at http://localhost:3002) and the tunnel together, with each line of output prefixed by its service. `api` and `agents` restart when any file they import changes, including shared packages. Ctrl-C stops everything, waiting for in-flight work like a deploy would, and a second Ctrl-C forces it. If the tunnel isn't set up, it reports that and the other services keep running.

`bun dev` also checks your computer, the seeded user's local VM (a Docker container). The seed requests it the way signing up does, and `bun dev` provisions it through the same job production uses. It requests it if it's somehow missing, retries it if it failed, replaces it if its container is gone, and prints `vm_… ready` with the `winstond` and CLI versions once it connects. If the image is missing or older than the code baked into it, it says so; rebuild it with:

```bash
bun run image:build:local
```

Then move the VM onto the new image. Its files in `/home/winston` are kept:

```bash
bun run vm:reset
```

Anyone else who signs in to the local site (with an allowlisted email) gets their own local VM the same way.

For a shell inside the VM as `winston`:

```bash
bun run vm:shell
```

While working on the site, http://localhost:3002/dev/design shows every page in every state, at desktop or mobile width, in light or dark. It exists only in development.

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

## Telegram dev bot

Each developer uses their own bot, so webhooks from your chats reach your machine. The maintainer's is @RunWinstonDevBot.

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and follow the prompts. Put the token it gives you in `TELEGRAM_BOT_TOKEN` in `.env.local`. `setup.sh` already generated `TELEGRAM_WEBHOOK_SECRET`.
2. Set `API_PUBLIC_URL` to your tunnel's hostname, then point the bot's webhook at it:

   ```bash
   bun run telegram:webhook
   ```

   It prints the webhook's status, including the last delivery error if there is one. Re-run it whenever the URL, secret or bot changes.

3. If your bot isn't @RunWinstonDevBot, set `TELEGRAM_BOT_USERNAME` in `.env.local` to its username (without the @).
4. Start `bun dev`, sign in at http://localhost:3002 and tap **Connect** under Telegram on Home or Profile (or scan the QR code with your phone). Telegram opens your bot; tap **Start**, and Winston says hello. Your chat is linked.

After resetting your database you can skip the site: the bot's `api` log line `message from an unlinked chat` shows your `chatId`, and putting it in `SEED_TELEGRAM_CHAT_ID` links it whenever `./scripts/setup.sh` seeds.
