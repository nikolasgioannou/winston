#!/usr/bin/env bash
# The two users and the directory layout (docs/design.md §10, §18):
# - winston: the agent's shell user. /home/winston is the data volume's mount
#   point on EC2, so everything Winston keeps lives there.
# - winstond: the daemon, with no login shell. Only it can read
#   /etc/winstond, which holds the VM token.
set -euo pipefail

if ! id winston >/dev/null 2>&1; then
  useradd --create-home --home-dir /home/winston --shell /bin/bash winston
fi
if ! id winstond >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/winstond --create-home --shell /usr/sbin/nologin winstond
fi

install -d -o winstond -g winstond -m 0700 /etc/winstond
