#!/usr/bin/env bash
# Winston's browser (docs/design.md §5 Browser, §10, §18): real Google Chrome
# stable, headful on an Xvfb display, with one persistent profile on the data
# volume. Google publishes the same stable build for amd64 and arm64, so the
# local image and production run the same browser.
set -euo pipefail

arch=$(dpkg --print-architecture)

# Google's apt repository, signed by its key. Chrome's own package would add
# the repository again and keep re-adding it from a daily cron job; telling it
# not to leaves this file the only copy.
apt-get update
apt-get install -y --no-install-recommends gnupg
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub |
  gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg
echo "deb [arch=$arch signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
  >/etc/apt/sources.list.d/google-chrome.list
cat >/etc/default/google-chrome <<'CONF'
repo_add_once="false"
repo_reenable_on_distupgrade="false"
CONF

# Xvfb for the display, and fonts beyond the base set so pages in Chinese,
# Japanese and Korean render (Latin and emoji come from base.sh).
apt-get update
apt-get install -y --no-install-recommends \
  google-chrome-stable xvfb fonts-noto-cjk
apt-get clean
rm -rf /var/lib/apt/lists/*

# The display: one 1920×1080 screen, local connections only.
cat >/etc/systemd/system/xvfb.service <<'UNIT'
[Unit]
Description=Virtual display :99 for Chrome

[Service]
User=winston
Group=winston
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

# Chrome itself, as winston. The flags keep it looking like a normal desktop
# Chrome (nothing like --enable-automation or --headless) while staying fit
# for long-running work:
# - the profile lives on the data volume, so logins survive a new instance;
# - DevTools listens on localhost only (headful Chrome never binds elsewhere);
# - background windows aren't throttled, since every agent drives its own;
# - no first-run, default-browser or crash-restore prompts, and the basic
#   password store, since there's no desktop keyring to ask.
# The memory limit means memory pressure restarts Chrome, not winstond.
cat >/etc/systemd/system/chrome.service <<'UNIT'
[Unit]
Description=Winston's Chrome
Requires=xvfb.service
After=xvfb.service
StartLimitIntervalSec=0

[Service]
User=winston
Group=winston
Environment=DISPLAY=:99
WorkingDirectory=/home/winston
# /run/chrome/started marks when this Chrome started, so an upgrade of the
# package can tell whether it's running an old binary (below).
RuntimeDirectory=chrome
ExecStartPre=/usr/bin/touch /run/chrome/started
# The profile's lock names the machine it was taken on. On a new instance
# (a restored volume) Chrome would see it as "in use on another computer"
# and refuse to start; systemd runs one Chrome only, so it's always stale.
ExecStartPre=/usr/bin/rm -f /home/winston/.config/winston-chrome/SingletonLock /home/winston/.config/winston-chrome/SingletonCookie /home/winston/.config/winston-chrome/SingletonSocket
ExecStart=/usr/bin/google-chrome-stable \
  --user-data-dir=/home/winston/.config/winston-chrome \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  --hide-crash-restore-bubble \
  --password-store=basic \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --disable-background-timer-throttling \
  --window-position=0,0 \
  --window-size=1920,1080 \
  about:blank
Restart=always
RestartSec=2
TimeoutStopSec=15
MemoryHigh=2G
MemoryMax=2560M

[Install]
WantedBy=multi-user.target
UNIT
systemctl enable xvfb.service chrome.service

# A Chrome left running on replaced files misbehaves, so after any package
# change, restart it if the binary is newer than the running Chrome.
cat >/etc/apt/apt.conf.d/90winston-restart-chrome <<'CONF'
DPkg::Post-Invoke { "if [ -e /run/chrome/started ] && [ /opt/google/chrome/chrome -nt /run/chrome/started ]; then systemctl try-restart chrome.service || true; fi"; };
CONF

# winstond restarts Chrome when it stops answering over CDP, and may do only
# that as root.
cat >/etc/sudoers.d/winstond-chrome <<'SUDOERS'
winstond ALL=(root) NOPASSWD: /usr/bin/systemctl restart chrome.service
SUDOERS
chmod 0440 /etc/sudoers.d/winstond-chrome
visudo -cf /etc/sudoers.d/winstond-chrome

# On EC2, prove Chrome starts with its sandbox on the real kernel (Ubuntu
# restricts the user namespaces it uses to programs AppArmor allows), so an
# AMI where it can't never ships. The Docker build runs under Docker's
# seccomp profile, which blocks them (the local VM lifts it; see
# docs/design.md §18).
if [ "${WINSTON_TARGET:-}" = "ec2" ]; then
  profile=$(mktemp -d)
  chown winston:winston "$profile"
  if ! dom=$(sudo -u winston timeout 60 google-chrome-stable --headless=new \
    --user-data-dir="$profile" --dump-dom 'data:text/html,<p>winston-chrome-ok</p>' 2>&1); then
    echo "chrome.sh: Chrome failed to start on this kernel:" >&2
    echo "$dom" >&2
    exit 1
  fi
  echo "$dom" | grep -q winston-chrome-ok
  rm -rf "$profile"
  echo "chrome.sh: Chrome starts with its sandbox"
fi
