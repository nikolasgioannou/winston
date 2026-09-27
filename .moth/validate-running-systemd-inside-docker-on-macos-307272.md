---
id: "307272"
title: Validate running systemd inside Docker on macOS
status: done
priority: none
labels:
  - m2
  - spike
  - vm
created_at: 2026-09-27T05:32:51.078Z
updated_at: 2026-09-27T23:39:23.218Z
blocked_by:
  - "0fa82e"
---

The local "VM" is meant to be a Docker container built from the same scripts as the production image, running **systemd as PID 1**, so the service units behave identically in dev and prod (docs/design.md §18). The design flags this as a risk. systemd inside Docker on macOS usually needs `--privileged`, cgroup namespace settings and a writable `/sys/fs/cgroup`, and Docker Desktop, OrbStack and Colima behave differently.

Spike it before anything depends on it:
- Research the current state of systemd in containers (cgroup v2, `--cgroupns=host` vs private, the `container=docker` env, the minimal set of masked units) on the Docker runtime the founder uses. Check which one first.
- Build a throwaway Ubuntu 24.04 image that boots systemd and runs two trivial units: one that depends on the other, one that crashes and gets restarted by `Restart=always`.
- Confirm `docker stop` shuts it down cleanly, and that a long-running headful process (Xvfb plus something drawing) works inside.

Outcome is a decision written into docs/design.md §18. Either "systemd-in-Docker works, with these exact run flags", or the fallback: a lightweight local Linux VM running the same provisioning scripts (research Lima or the founder's Docker runtime's VM feature, mise-installable if possible). The throwaway files don't need to be committed, but the exact working flags do, in the doc.

## Outcome

systemd-in-Docker works on the user's runtime (Colima, VZ, aarch64, cgroup v2, Docker 29.5) **without `--privileged`**: `--cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock`, with `container=docker`, `STOPSIGNAL SIGRTMIN+3`, `/sbin/init` and a short list of masked units. The exact flags, what was verified, what failed and the trade-off are in docs/design.md §18. The fallback VM isn't needed. The throwaway spike files weren't committed.

The spike surfaced the architecture split: local arm64, production x86_64. I added it to the Packer ticket (scripts must work on both) and the Chrome ticket (Chrome's linux-arm64 availability).
