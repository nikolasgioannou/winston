#!/usr/bin/env bash
# Sets up this repo for development. Safe to run any number of times: each step
# checks whether it's already done first, so a re-run doubles as a health check.
#
#   1. Check that mise is installed (it's global, so this script never installs it).
#   2. Trust the repo's mise.toml.
#   3. Install the runtimes pinned in mise.toml.
#   4. Install dependencies from bun.lock, without changing it.
#   5. Check that the git hooks are installed, and install them if not.
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

echo "Done."
