---
id: "9c8906"
title: Pushes to main change production VMs without a deploy
status: done
priority: none
labels:
  - infra
  - tooling
created_at: 2026-10-04T02:57:03.637Z
updated_at: 2026-10-04T03:08:57.228Z
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

## As built

- **Pushes only check.** `ci.yml`'s `ami` job now runs only on the hand-started deploy run (`if: workflow_dispatch`), alongside `images`, and `deploy` needs both. `ami.yml` is gone: its job (a rebuild with no `image/` change) is the workflow's **Rebuild the VM image** input (`-f vm_image=true`, passing `--force`).
- **What needs a build** (`scripts/vm-image.ts`, shared by the build and the deploy): AMIs carry a `Commit` tag (a new Packer variable; `<sha>.dirty` for a build with uncommitted changes, so no deploy picks it up). An AMI already built from the commit is reused; otherwise it builds when `image/` changed since the commit production's AMI was built from, or when that can't be told (no `Commit` tag, a commit outside this one's history, or a parameter the AMI role can't read yet).
- **`image:build:ami` no longer writes `/winston/vm-ami`.** It tags the AMI and cleans up old ones as before, but never deregisters the one production runs, since three builds can now pile up between deploys.
- **`deploy.ts`:** after `cdk deploy`, it finds the AMI built from the commit, and fails before migrations if `image/` changed and there's none (the case for `bun run deploy` from a laptop without a build). As its last step, after the services are healthy and the VM binaries are published, it records the new AMI in `/winston/vm-ami`.
- **IAM** (`infra/src/ci.ts`): the deploy role can read and write `/winston/vm-ami` and describe images; the AMI role can only read the parameter now. A new stack test checks that only the deploy role writes it.
- **Bootstrap:** on the first deploy with this change, the AMI role can't read the parameter yet (the `ami` job runs before `cdk deploy` grants it), so it builds an image, and the deploy records it. That one extra build is expected.
- **Not checked against production:** the `winston-prod` SSO session had expired, so the AWS-side lookups have only been typechecked. The first deploy is the live test.
