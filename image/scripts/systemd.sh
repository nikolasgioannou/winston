#!/usr/bin/env bash
# systemd as PID 1. In a container, mask the units that make no sense there
# (validated in docs/design.md §18). On a real VM there's nothing to do.
set -euo pipefail

if [ "${WINSTON_TARGET:-}" = "docker" ]; then
  systemctl mask \
    systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
    systemd-modules-load.service \
    sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount \
    systemd-remount-fs.service \
    getty.target console-getty.service \
    systemd-logind.service
fi
