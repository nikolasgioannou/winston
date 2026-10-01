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
