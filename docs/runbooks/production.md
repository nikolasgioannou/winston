# Production operations

There's no admin UI by design. Anything that has to touch production data runs as a **one-off ECS task** on the `ops` image (`packages/db/src/ops.ts`, built by `docker/ops.Dockerfile`), started from your machine with `bun run prod`. The task runs in the VPC next to the services, reads the database password from the RDS-managed secret like they do, and needs no bastion, no open port and no public database (docs/design.md §19).

Log in first (docs/runbooks/aws-access.md): `aws sso login --profile winston-prod`. The script uses that profile unless AWS credentials are already set (as in CI).

## Commands

```sh
bun run prod allowlist list
bun run prod allowlist add someone@example.com      # asks for confirmation
bun run prod allowlist remove someone@example.com   # asks for confirmation
bun run prod sql "select id, state from vms"        # read-only, rows as JSON
bun run prod migrate                                # asks for confirmation
bun run prod vm:restore someone@example.com         # from its latest snapshot (vm-recovery.md); asks
bun run prod vm:roll someone@example.com            # onto the current image now, unless busy; asks
bun run prod costs [--user <email>] [--month 2026-10]  # spend (costs.md)
```

- Each command starts a task on the image tag production currently runs (`/winston/image-tag`), prints its logs as they arrive, and exits with the task's exit code.
- Anything that writes asks you to type `yes` first. `--yes` skips the prompt; deploys use it for migrations.
- `sql` runs inside a read-only transaction, so even a stray `delete` fails ("cannot execute … in a read-only transaction"). For a one-off fix that writes, add a reviewed command to `ops.ts` instead of loosening this.
- After `allowlist add`, the person can sign in. Before they connect mail or calendar, add each Google account they'll connect as a test user on the OAuth consent screen (docs/runbooks/google-cloud.md).
- Each task costs a fraction of a cent and takes about a minute, most of it Fargate starting the container.

## Why one-off tasks

ECS Exec into a running service would need the SSM agent and an exec-enabled task role on every service, and would run admin code inside a serving process. A bastion with an SSM port-forward to RDS would be one more thing to keep patched. A one-off task uses the same image, network and permissions model as everything else, and stops when it's done.

## If a task won't start

The script prints ECS's `stoppedReason`. The usual causes:

- **`CannotPullContainerError`:** the `ops` image for the current tag wasn't pushed. Deploys push it along with the services; push it with the commands in docs/runbooks/deploys.md (Deploying from a laptop).
- **`ResourceInitializationError` reading the secret:** the task role lost access to the database secret; redeploy the Services stack.

## Logs

Each service writes to its own CloudWatch log group, named by CDK (`winston-services-<service>Logs…`); one-off tasks write to `/winston/ops`. Find and follow them:

```sh
aws logs describe-log-groups --log-group-name-prefix winston-services --query 'logGroups[].logGroupName' --profile winston-prod
aws logs tail <group> --since 1h --follow --profile winston-prod
aws logs tail <group> --since 1h --filter-pattern '"turn completed"' --profile winston-prod
```

Lines are JSON (pino): `level` 40 is a warning, 50 an error; `runId`, `userId` and `vmId` are on the lines they concern.

## What production runs

```sh
aws ssm get-parameter --name /winston/image-tag --profile winston-prod      # the services' commit
aws ssm get-parameter --name /winston/vm-ami --profile winston-prod         # the current VM image
bun run prod sql "select user_id, state, image_id, cli_version, winstond_version, gateway_url from vms"
```

The services move on a deploy; VM binaries (`winston`, `winstond`) self-update within a minute of one. Anything in the VM _image_ (system packages, Chrome, `x11vnc` for the live view's full desktop) reaches an existing VM only when it rolls onto the new AMI: automatically in its user's quiet hours (3–5 am), or now with `bun run prod vm:roll <email>` (docs/runbooks/deploys.md).

## A shell on a user's VM

Only for debugging, never routinely: it's the user's computer. Session Manager is the only way in (no SSH, no open ports):

```sh
bun run prod sql "select instance_id from vms where user_id = '<usr_…>'"
aws ssm start-session --target <instance_id> --profile winston-prod
```

## See also

- [deploys.md](deploys.md): deploying, rolling back, the VM image.
- [vm-recovery.md](vm-recovery.md): replacing, rolling and restoring a VM.
- [secrets.md](secrets.md): production keys and rotation.
- [costs.md](costs.md): budgets, limits and the spend report.
- [aws-access.md](aws-access.md), [dns.md](dns.md), [google-cloud.md](google-cloud.md), [gcp-terraform.md](gcp-terraform.md).
