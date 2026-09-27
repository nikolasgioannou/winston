---
id: "ea07c8"
title: Create the Packer template and provisioning scripts for the local image
status: todo
priority: none
labels:
  - m2
  - tooling
  - vm
created_at: 2026-09-27T05:32:51.127Z
updated_at: 2026-09-27T05:32:51.158Z
blocked_by:
  - "307272"
---

One Packer template (`image/winston.pkr.hcl`) will produce both the production AMI and the local Docker image from the **same provisioning scripts** (docs/design.md §18). This ticket builds the template with the `docker` source only. The `amazon-ebs` source is added in M4.

Research Packer thoroughly first:
- HCL2 templates, the `docker` builder (commit vs export, `changes` for `CMD`/`ENTRYPOINT`), shell provisioners, variables, and running multiple sources from one build.
- Pinning Packer through mise (add it to `mise.toml`) rather than installing it globally.
- Adapting the result of the systemd spike (container flags, masked units) into the image and the run command.

Provisioning scripts in `image/scripts/`, split by concern and runnable on a plain Ubuntu 24.04 host:
- Base packages: `rg`, `jq`, `unzip`, `curl`, ImageMagick, `pandoc`, Python 3 with `pip`/`venv`, and fonts (Chrome pages look broken without decent fonts).
- System users: `winston` (the agent's shell user) and `winstond` (the daemon, with no login shell).
- Directory layout: `/home/winston` as the data mount point, `/etc/winstond/` for the daemon's config and token (owned by `winstond`, mode 0700).
- systemd unit files as placeholders for `winstond`. Xvfb, Chrome and noVNC arrive with M8.
- Swap and unattended-upgrades are EC2-only concerns. Guard them so the Docker build skips them.

Add `bun run image:build:local`. Done when it produces a Docker image that boots with systemd and has both users and the directory layout.

Also, from the systemd spike (docs/design.md §18): the local image is **arm64** (native on Apple Silicon; emulating amd64 crashes Bun), while the AMI is x86_64. So every provisioning script must work on both architectures (package names, download URLs chosen by `uname -m`).
