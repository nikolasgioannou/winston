#!/bin/sh
set -eu
umask 077

# Only the broker can write the mount root; Chromium owns its profile child.
test "$(id -u)" = 0
test ! -L /data
mountpoint -q /data
test "$(stat -c %u /data)" = 0
test -z "$(find /data -maxdepth 0 -perm /022)"
test ! -L /data/.browser.lock
if test -e /data/.browser.lock; then
  test -f /data/.browser.lock
  test "$(stat -c %u /data/.browser.lock)" = 0
  test "$(stat -c %h /data/.browser.lock)" = 1
  test -z "$(find /data/.browser.lock -maxdepth 0 -perm /077)"
fi

export WINSTON_BROWSER_LOCKED=1
# Run as the container entrypoint, never under an in-place process restarter.
# Broker exit ends the container (or Fly Machine), including detached descendants.
exec flock --nonblock --no-fork /data/.browser.lock /usr/bin/tini -s -g -- /usr/local/bin/bun /app/main.js "$@"
