# Deploys

Deploys are started by hand (docs/design.md §8b; the founder's call, 2026-10-02, since a 13-minute deploy after every commit was too slow): **Actions → CI → Run workflow** on `main`, or:

```bash
gh workflow run ci.yml --ref main
```

That run checks, builds the images and runs `bun run deploy` (`scripts/deploy.ts`) with GitHub's deploy role, deploying `main` as it is, however many commits have landed since the last deploy. Every push to `main` still runs the checks (and builds the VM image when `image/` changed), so `main` is always deployable. There's no staging.

## What a deploy does

1. **`check`:** `bun run check`, the same as the pre-commit hook. A failure stops everything. (On a push, this is the whole run, apart from `ami`.)
2. **`images`:** builds `api`, `agents`, `gateway`, `web` and `ops` on native ARM64 runners and pushes each to ECR as `winston/<image>:<commit SHA>`, with GitHub's layer cache. Tags are immutable; an image already pushed for this commit (a re-run) is skipped.
3. **`deploy`** (one at a time: a newer push waits for the running one):
   1. Checks every image for this commit is in ECR.
   2. `cdk deploy --all`, so infrastructure lands before code that needs it. The services keep running the old version: their image tag comes from `/winston/image-tag`, which hasn't moved yet.
   3. **Migrations** on the new `ops` image (`bun run prod migrate --yes --image <sha>`, which registers an ops task revision with that tag). If they fail, the deploy stops and the old version keeps running.
   4. Sets `/winston/image-tag` to the commit and deploys the Services stack (`--force`, since only the parameter changed). ECS rolls each service with the deployment circuit breaker. If a service doesn't get healthy, ECS and CloudFormation roll back, and the script puts the parameter back.
   5. Publishes the VM binaries (`bun run vm:publish`); the gateway offers them to every connected VM within a minute.

4. **`ami`** (on pushes, not deploys, and only when something under `image/` changed): builds the VM image with Packer (`bun run image:build:ami`, about 15 minutes) and records it in `/winston/vm-ami`. New VMs launch from it, and agents moves each existing VM onto it in its user's quiet hours (3–5 am in their time zone), when nothing's running and no handoff is live: a new instance from the new image on the same data volume, so notes, files and logins carry over. To move one now instead: `bun run prod vm:roll <email>` (skipped if it's current or busy). See docs/design.md §18.

A deploy takes about 10–15 minutes, most of it ECS rolling the four services.

Running tasks keep working through it. While the old and new gateway overlap, each VM's calls go to whichever holds its socket (`vms.gateway_url`), and a VM that's reconnecting is waited on for up to 20 s, so Winston doesn't see its computer as down (docs/design.md §19).

## Watching

- GitHub: the repository's Actions tab, or `gh run watch`.
- AWS: `aws ecs describe-services --cluster <cluster> --services <service>` (the cluster is the Services stack's `ClusterName` output), CloudFormation events for `winston-services`, and each service's logs (`aws logs tail <group> --follow`).
- What production runs: `aws ssm get-parameter --name /winston/image-tag`, and the VMs' versions with `bun run prod sql "select cli_version, winstond_version from vms"`.

## Rolling back

Redeploy an earlier commit: its images are still in ECR (the last 30 are kept).

```sh
git checkout <good sha>
AWS_PROFILE=winston-prod bun run deploy
```

Better still, revert the bad commit on `main` and push, so `main` and production agree. Migrations aren't rolled back: write the next migration forward instead, and keep migrations backward compatible (add columns before the code uses them, drop them a deploy later), so the previous version always runs on the new schema.

## If migrations fail halfway

Drizzle runs each migration in its own transaction, so a failed one leaves nothing half-applied, but the ones before it stay applied. The old version keeps running on them, which is why migrations must stay backward compatible.

1. Read the error in the deploy log (or `aws logs tail /winston/ops`).
2. Fix the migration in a new commit and push; the next deploy applies what's left.
3. Look at the schema meanwhile with `bun run prod sql "…"` (read-only).

## Deploying from a laptop

`bun run deploy` works locally with the `winston-prod` profile, as long as the commit's images are in ECR. To build and push them:

```sh
SHA=$(git rev-parse HEAD); REG=766577085959.dkr.ecr.us-east-1.amazonaws.com
aws ecr get-login-password --profile winston-prod | docker login --username AWS --password-stdin $REG
bun run docker:build
for image in api agents gateway web ops; do docker tag "winston-${image}:local" "$REG/winston/${image}:$SHA" && docker push "$REG/winston/${image}:$SHA"; done
```
