#!/usr/bin/env bash
# winstond: its binary (uploaded to /tmp/winstond by Packer) and its systemd
# unit (docs/design.md §10, §15). It runs as the winstond user, the only one
# that can read /etc/winstond/token.
set -euo pipefail

install -o root -g root -m 0755 /tmp/winstond /usr/local/bin/winstond
rm -f /tmp/winstond

cat >/etc/systemd/system/winstond.service <<'UNIT'
[Unit]
Description=winstond, the VM's link to Winston
Wants=network-online.target
After=network-online.target

[Service]
User=winstond
Group=winstond
ExecStart=/usr/local/bin/winstond
Restart=always
RestartSec=2
# Docker passes these to PID 1 (systemd); a service only sees what's passed on.
PassEnvironment=WINSTON_REGISTRATION_TOKEN WINSTON_GATEWAY_URL

[Install]
WantedBy=multi-user.target
UNIT
systemctl enable winstond.service
