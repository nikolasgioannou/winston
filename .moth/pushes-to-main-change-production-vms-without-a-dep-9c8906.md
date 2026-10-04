---
id: "9c8906"
title: Pushes to main change production VMs without a deploy
status: backlog
priority: none
labels:
  - infra
  - tooling
created_at: 2026-10-04T02:57:03.637Z
updated_at: 2026-10-04T02:57:03.637Z
---

Deploys are by hand (58a0c2f), but CI's `ami` job still runs on every push to `main` that changes `image/`: it builds a VM image and records it in `/winston/vm-ami`, and agents moves every VM onto it in its user's quiet hours (`apps/agents/src/vm/rollout.ts`). So an image change reaches every user's computer without anyone deploying, possibly ahead of the backend change it relies on (the VM binaries are published by deploys, the image by pushes). It matters more once Winston can push code himself (founder, 2026-10-03).

The founder's rule: **a push to `main` only runs checks; one deploy action ships everything at once.**

**What to build**

- `ci.yml`: a push runs `check` and nothing else. The `ami` job moves into the deploy run (started by hand), next to the service images.
- The deploy builds a new image only when `image/` changed since the image production runs now, not since the previous push (a deploy usually covers many pushes). That needs the image's commit recorded, e.g. as a tag on the AMI or next to `/winston/vm-ami`.
- The image build (~15 min) runs alongside the service images, not after them, and `/winston/vm-ami` moves as part of the deploy, after the services are healthy, so VMs never move onto an image ahead of the backend it was built with.
- `.github/workflows/ami.yml` (build by hand) either goes or stays as the way to rebuild without deploying; decide and document it.
- Update `docs/runbooks/deploys.md` (the `ami` step, "on pushes, not deploys") and `docs/design.md` §10 and §18 (AMI builds, "image changes reach production without a manual deploy").

**Done when**

- [ ] A push to `main` that changes `image/` runs only the checks, and `/winston/vm-ami` doesn't change
- [ ] A deploy whose commits changed `image/` builds one image and records it in `/winston/vm-ami` only after the services are healthy; VMs then roll in quiet hours as before
- [ ] A deploy with no `image/` changes since the current image builds none
- [ ] A failed image build fails the deploy and leaves `/winston/vm-ami` as it was
- [ ] The runbook and design docs describe it as built
