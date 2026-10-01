#!/usr/bin/env bash
# winstond: its binary (uploaded to /tmp/winstond by Packer) and its systemd
# unit (docs/design.md §10, §15). It runs as the winstond user, the only one
# that can read /etc/winstond/token.
set -euo pipefail

# Owned by winstond, so it can replace itself when it self-updates (M4).
install -d -o winstond -g winstond -m 0755 /usr/local/lib/winstond
install -o winstond -g winstond -m 0755 /tmp/winstond /usr/local/lib/winstond/winstond
rm -f /tmp/winstond

# winstond runs the agent's commands as winston, and may do nothing else as
# anyone (docs/design.md §15). winston itself gets no sudo rights.
cat >/etc/sudoers.d/winstond <<'SUDOERS'
winstond ALL=(winston) NOPASSWD: ALL
SUDOERS
chmod 0440 /etc/sudoers.d/winstond
visudo -cf /etc/sudoers.d/winstond

# Before each start: if a self-update of winstond is pending and the new
# binary has failed to start three times, put the previous one back and mark
# that version failed, so it isn't offered again (apps/winstond/src/updater.ts).
cat >/usr/local/lib/winstond/prestart.sh <<'SCRIPT'
#!/bin/sh
dir=${WINSTOND_DIR:-/usr/local/lib/winstond}
[ -f "$dir/update-pending" ] || exit 0
starts=$(cat "$dir/update-pending.starts" 2>/dev/null || echo 0)
starts=$((starts + 1))
if [ "$starts" -gt 3 ] && [ -f "$dir/winstond.previous" ]; then
  mv -f "$dir/winstond.previous" "$dir/winstond"
  mv -f "$dir/update-pending" "$dir/update-failed"
  rm -f "$dir/update-pending.starts"
  echo "winstond: the new version failed to start; rolled back" >&2
else
  echo "$starts" >"$dir/update-pending.starts"
fi
SCRIPT
chown root:root /usr/local/lib/winstond/prestart.sh
chmod 0755 /usr/local/lib/winstond/prestart.sh

cat >/etc/systemd/system/winstond.service <<'UNIT'
[Unit]
Description=winstond, the VM's link to Winston
Wants=network-online.target
After=network-online.target

[Service]
User=winstond
Group=winstond
ExecStartPre=/usr/local/lib/winstond/prestart.sh
ExecStart=/usr/local/lib/winstond/winstond
Restart=always
RestartSec=2
# /run/winstond holds the CLI's socket (/run/winstond/winstond.sock).
RuntimeDirectory=winstond
RuntimeDirectoryMode=0755
# Docker passes these to PID 1 (systemd); a service only sees what's passed on.
PassEnvironment=WINSTON_REGISTRATION_TOKEN WINSTON_GATEWAY_URL
# No NoNewPrivileges=: winstond runs commands as winston through sudo.

[Install]
WantedBy=multi-user.target
UNIT
systemctl enable winstond.service
