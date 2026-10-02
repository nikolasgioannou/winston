---
id: "eadb89"
title: Roll VMs onto new images automatically
status: done
priority: none
labels:
  - infra
  - m8
  - vm
created_at: 2026-10-02T03:53:37.406Z
updated_at: 2026-10-02T03:59:11.164Z
blocked_by:
  - "63475d"
---

Found when Chrome (63475d) needed a manual restore to reach the founder's VM: deploys update the services and winstond/CLI (self-update), but anything in the image (system packages, Chrome, systemd units) only reaches new VMs. Decision #45 made image rollouts manual; with more than one user that doesn't hold. Image changes should ship like everything else.

- **CI builds the AMI** when `image/` changes (a job in the CI workflow after `check`, using the existing AMI role), recording it in `/winston/vm-ami`. The manual AMI workflow stays for rebuilds.
- **Each VM knows its image:** `vms.image_id`, set when the instance is created (EC2: the instance's AMI; Docker: the image id).
- **Agents roll VMs onto the current image:** a periodic sweep finds ready VMs on another image (or none recorded) and replaces each with the existing replace path (`provisionVm` with `replace`: new instance, same live data volume, so notes, files and logins carry over; not a snapshot restore).
- **Only when it won't hurt:** in the user's quiet hours (3–5 am in their time zone by default; any time locally), with no run in progress and no live handoff. Otherwise it waits for the next sweep.
- Docs: decision #45 updated, deploy and recovery runbooks, local dev (a rebuilt local image rolls the local VM by itself).

Tests: outdated detection (other image, none recorded), the quiet-hours and busy checks, the roll replacing on the same volume and recording the image, providers reporting images.

## As built

- `vms.image_id`; `VmProvider.create` returns the image and `currentImage()` reads the current one (EC2: `/winston/vm-ami` via SSM, which agents could already read; Docker: the local image id).
- `apps/agents/src/vm/rollout.ts`: a 15-minute sweep queues `roll_vm` for ready VMs on another image (or none recorded) in their user's rollout hours (`VM_ROLLOUT_HOURS`, default 3-5 on EC2, 0-24 locally) with no running run and no live handoff from the last 24 h; the job re-checks and replaces via `provisionVm({ replace: true })`.
- CI `ami` job after `check` when `image/` changed (existing AMI role); `ami.yml` kept for manual rebuilds.
- Docs: decision #45, §18, deploys runbook, local dev.
- The founder's VM (no image recorded, on the pre-Chrome AMI) moves onto the Chrome image at its next quiet hours after this deploys.

