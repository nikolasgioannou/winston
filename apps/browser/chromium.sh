#!/bin/sh
set -eu
test "$(id -u)" = 0
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/data/profile DISPLAY=:99 LANG=C.UTF-8 \
  /usr/bin/setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs --bounding-set=-all \
  /usr/bin/chromium "$@"
