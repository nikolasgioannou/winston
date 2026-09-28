#!/usr/bin/env bash
# Base packages every Winston VM has. Works on amd64 and arm64.
set -euo pipefail

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl unzip jq ripgrep \
  imagemagick pandoc \
  python3 python3-pip python3-venv \
  fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-color-emoji \
  systemd systemd-sysv dbus sudo
apt-get clean
rm -rf /var/lib/apt/lists/*
