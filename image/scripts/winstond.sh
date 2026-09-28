#!/usr/bin/env bash
# winstond: its binary (uploaded to /tmp/winstond by Packer) and its systemd
# unit (docs/design.md §10, §15). It runs as the winstond user, the only one
# that can read /etc/winstond/token.
set -euo pipefail

install -o root -g root -m 0755 /tmp/winstond /usr/local/bin/winstond
rm -f /tmp/winstond

# winstond runs the agent's commands as winston, and may do nothing else as
# anyone (docs/design.md §15). winston itself gets no sudo rights.
cat >/etc/sudoers.d/winstond <<'SUDOERS'
winstond ALL=(winston) NOPASSWD: ALL
SUDOERS
chmod 0440 /etc/sudoers.d/winstond
visudo -cf /etc/sudoers.d/winstond

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
