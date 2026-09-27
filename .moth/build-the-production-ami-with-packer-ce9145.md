---
id: "ce9145"
title: Build the production AMI with Packer
status: todo
priority: none
labels:
  - infra
  - m4
  - vm
created_at: 2026-09-27T05:36:32.846Z
updated_at: 2026-09-27T05:36:32.898Z
blocked_by:
  - "245cbb"
  - "f25d3b"
---

Add the `amazon-ebs` source to the existing Packer template, so the **same provisioning scripts** that build the local Docker image also build the production AMI (docs/design.md §18).

Research Packer's `amazon-ebs` builder: source AMI filters for the latest official Ubuntu 24.04 LTS x86_64, authenticating with the SSO profile locally and via OIDC in CI, AMI naming and tagging, encryption, and cleaning up old AMIs.

EC2-only provisioning steps, guarded so the Docker build skips them:
- A 2 GB swap file, and unattended-upgrades configured to apply Ubuntu security updates (and, once M8 adds Chrome, the Chrome apt repository) at a quiet hour (§10).
- Mounting the **separate data volume** at `/home/winston` on boot. Research a robust way to find the right EBS device (NVMe device naming is unstable, so use the volume id via the NVMe serial or a udev rule), format it only if it's blank, and mount it through fstab or a systemd mount unit.
- The SSM agent (preinstalled on Ubuntu AMIs, but verify), so admin access works without SSH.

Add a manually triggered GitHub Actions workflow `ami.yml` that builds and registers the AMI, plus a local `bun run image:build:ami`. Record the latest AMI id where the Vm stack can find it (an SSM parameter is a good fit).

Done when an AMI exists, and an instance launched from it by hand boots with the data volume mounted and `winstond` installed.

From the local image ticket: add the **EC2-only** provisioning here, guarded by `WINSTON_TARGET=ec2` so the Docker build skips it: the 2 GB swap file and unattended-upgrades (docs/design.md §18). They weren't written earlier because nothing could test them before the EC2 build existed.
