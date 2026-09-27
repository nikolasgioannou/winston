#!/usr/bin/env bash
# Sets up this repo for development. Safe to run any number of times: each step
# checks whether it's already done first, so a re-run doubles as a health check.
#
#   1. Check that mise is installed (it's global, so this script never installs it).
#   2. Trust the repo's mise.toml.
#   3. Install the runtimes pinned in mise.toml.
#   4. Install dependencies from bun.lock, without changing it.
#   5. Check that the git hooks are installed, and install them if not.
#   6. Create .env.local from .env.example if it doesn't exist (never overwrites it).
#   7. Generate a Telegram webhook secret in .env.local if it has none, and check
#      that a bot token is set (setup: docs/local-dev.md).
#   8. Check that a Docker engine is reachable (starting Colima if it's installed but
#      stopped). Docker is a machine-level prerequisite, so this script never installs it.
#   9. Start the local Postgres and wait until it's healthy.
#  10. Apply database migrations (already-applied ones are skipped).
#  11. Seed the local database with your user, once SEED_* values are set in .env.local.
#  12. Check that the Cloudflare Tunnel in .env.local exists (setup: docs/local-dev.md).
set -euo pipefail

cd "$(dirname "$0")/.."

# mise's "new version available" notice is about the user's global install, not
# this repo, so keep it out of the output.
export MISE_DISABLE_UPDATE_WARNING=1

if [ -t 1 ]; then
  green=$'\033[32m' cyan=$'\033[36m' red=$'\033[31m' reset=$'\033[0m'
else
  green='' cyan='' red='' reset=''
fi
done_() { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
doing() { printf '  %s→%s %s\n' "$cyan" "$reset" "$1"; }
fail() {
  printf '  %s✗%s %s\n' "$red" "$reset" "$1" >&2
  exit 1
}

echo "Setting up Winston"

# mise pins the runtimes (mise.toml). It's a global tool, so we don't install it.
if ! command -v mise >/dev/null 2>&1; then
  fail "mise is not installed. Install it (https://mise.jdx.dev/getting-started.html), then re-run ./scripts/setup.sh"
fi
done_ "mise $(mise --version | cut -d' ' -f1)"

if mise trust --show 2>/dev/null | grep -q ': trusted'; then
  done_ "mise.toml is trusted"
else
  doing "trusting mise.toml"
  mise trust --quiet
fi

if [ -z "$(mise ls --current --missing --local 2>/dev/null)" ]; then
  done_ "pinned runtimes installed"
else
  doing "installing pinned runtimes"
  mise install
fi

# Dependencies come from the lockfile as-is. Bun is fast when nothing changed,
# and repairs anything missing. This also installs the git hooks (`prepare`).
if ! install_output=$(mise exec -- bun install --frozen-lockfile 2>&1); then
  echo "$install_output" >&2
  fail "dependency install failed"
fi
done_ "dependencies installed from bun.lock"

hooks_ok=true
for hook in pre-commit commit-msg; do
  grep -qs lefthook ".git/hooks/$hook" || hooks_ok=false
done
if $hooks_ok; then
  done_ "git hooks installed"
else
  doing "installing git hooks"
  mise exec -- bunx lefthook install >/dev/null
  done_ "git hooks installed"
fi

if [ -f .env.local ]; then
  done_ ".env.local exists"
else
  doing "creating .env.local from .env.example"
  cp .env.example .env.local
fi

if grep -qE '^TELEGRAM_WEBHOOK_SECRET=.+' .env.local; then
  done_ "Telegram webhook secret set"
else
  doing "generating a Telegram webhook secret in .env.local"
  secret=$(openssl rand -hex 32)
  # Replace the empty line in place, or append one if the file predates it.
  awk -v line="TELEGRAM_WEBHOOK_SECRET=$secret" '
    /^TELEGRAM_WEBHOOK_SECRET=/ { print line; found = 1; next }
    { print }
    END { if (!found) print line }
  ' .env.local >.env.local.tmp
  mv .env.local.tmp .env.local
fi
if grep -qE '^TELEGRAM_BOT_TOKEN=.+' .env.local; then
  done_ "Telegram bot token set"
else
  done_ "Telegram bot token not set yet (needed by the api; see docs/local-dev.md)"
fi

if docker info >/dev/null 2>&1; then
  done_ "Docker engine reachable"
elif command -v colima >/dev/null 2>&1; then
  doing "starting Colima"
  colima start >/dev/null 2>&1 || fail "Colima failed to start. Run 'colima start' to see why"
  done_ "Docker engine reachable"
else
  fail "No Docker engine found. Install a Docker-compatible runtime (for example Colima), then re-run ./scripts/setup.sh"
fi

if [ "$(docker inspect --format '{{.State.Health.Status}}' winston-postgres-1 2>/dev/null)" = "healthy" ]; then
  done_ "Postgres running"
else
  doing "starting Postgres"
  docker compose up --detach --wait postgres >/dev/null 2>&1 || fail "Postgres failed to start. Run 'docker compose up postgres' to see why"
  done_ "Postgres running"
fi

if ! migrate_output=$(mise exec -- bun run db:migrate 2>&1); then
  echo "$migrate_output" >&2
  fail "database migrations failed"
fi
done_ "database migrated"

if grep -qE '^SEED_EMAIL=.+' .env.local; then
  if ! seed_output=$(mise exec -- bun run db:seed 2>&1); then
    echo "$seed_output" >&2
    fail "seeding failed"
  fi
  done_ "database seeded"
else
  done_ "seed skipped (set the SEED_* values in .env.local to create your user)"
fi

tunnel_name=$(grep -E '^TUNNEL_NAME=' .env.local | cut -d= -f2-)
if [ -n "$tunnel_name" ] && mise exec -- cloudflared tunnel info "$tunnel_name" >/dev/null 2>&1; then
  done_ "Cloudflare Tunnel '$tunnel_name' exists"
else
  done_ "tunnel not set up yet (needed for webhooks; see docs/local-dev.md)"
fi

echo "Done."
