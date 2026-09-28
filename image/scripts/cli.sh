#!/usr/bin/env bash
# The winston CLI (uploaded to /tmp/winston by Packer): on everyone's PATH,
# run by the agent's commands as winston (docs/design.md §11).
set -euo pipefail

install -o root -g root -m 0755 /tmp/winston /usr/local/bin/winston
rm -f /tmp/winston
