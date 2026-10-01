#!/usr/bin/env bash
# The winston CLI (uploaded to /tmp/winston by Packer): on everyone's PATH,
# run by the agent's commands as winston (docs/design.md §11). It lives in
# winstond's directory, owned by winstond, so winstond can replace it when it
# self-updates; /usr/local/bin/winston links to it.
set -euo pipefail

if ! id winstond >/dev/null 2>&1; then
  echo "cli.sh: the winstond user must exist (users.sh)" >&2
  exit 1
fi
install -d -o winstond -g winstond -m 0755 /usr/local/lib/winstond
install -o winstond -g winstond -m 0755 /tmp/winston /usr/local/lib/winstond/winston
ln -sfn /usr/local/lib/winstond/winston /usr/local/bin/winston
rm -f /tmp/winston
