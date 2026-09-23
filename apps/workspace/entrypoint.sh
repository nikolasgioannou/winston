#!/bin/sh
set -eu
umask 077

# The real mount and its root are controlled by the operator, never by the execution user.
test "$(id -u)" = 0
test ! -L /data
mountpoint -q /data
test "$(stat -c %u /data)" = 0
test -z "$(find /data -maxdepth 0 -perm /022)"
test ! -L /data/.runtime.lock

export WINSTON_RUNTIME_LOCKED=1
exec flock --nonblock --no-fork /data/.runtime.lock /usr/local/bin/bun /app/main.js "$@"
