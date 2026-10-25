# Pausing production

Production was paused on **2026-10-25**, so it costs almost nothing while Winston isn't in use. For one user, AWS had been costing $4.29 a day (about $130 a month) whether Winston was busy or idle, and the models another $75–100 a month (costs.md). Everything that runs or holds a public address was deleted. The data was kept as two snapshots, so Winston can come back where he left off.

## What's kept

| What                    | Where                                                                                                                                                    | Holds                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The database            | RDS manual snapshot **`winston-paused-2026-10`**, taken as the instance was deleted (1.7 GB used of 20)                                                  | Everything in Postgres: users, conversations, runs, triggers, connections' encrypted tokens, sites, the cost ledger        |
| The user's computer     | EBS snapshot **`snap-0f5e33d8a18b782ff`** of the data volume, with the volume's tags (`winston:role=data`, `winston:user`), which `vm:restore` looks for | `/home/winston`: notes, files, inbox, site skills, the Chrome profile and its logins                                       |
| Attachments and bundles | The `blobs` bucket                                                                                                                                       | Screenshots, attachments and site bundles the database refers to                                                           |
| Mail                    | The `inboundMail` bucket; SES still receives mail for `runwinston.email`                                                                                 | Raw mail to Winston's addresses                                                                                            |
| KMS keys                | `alias/winston/tokens`, `alias/winston/vm-binary-signing`                                                                                                | The tokens key decrypts the connections' tokens in the snapshot; the signing key's public half is compiled into `winstond` |
| The other stacks        | Network, Data, Edge, Ci, Vm, Mail, Budget, CDKToolkit                                                                                                    | Nothing in them bills by the hour                                                                                          |

Outside AWS nothing was changed: the GitHub repository and its secrets, the Google Cloud project, the OpenRouter keys, and the Cloudflare domains and DNS records (which now point at deleted targets).

## What was deleted

- **The Services stack:** the four Fargate services, the load balancer, CloudFront, the ECS cluster and the `ops` task definition. Its log groups were retained and empty themselves within a month.
- **The VM:** instance `i-09476d49c48aaf90d`, its root volume and its data volume `vol-07fc3e3340e8510eb` (after the snapshot above), the 14 nightly snapshots, and all 4 VM images with their snapshots. `/winston/vm-ami` still names `ami-071175628e670e463`, which no longer exists.
- **The database** `winston-data-databaseb269d8bb-drtce8srv7bq`, its automated backups, and its RDS-managed password secret (`rds!db-…`).
- **The 11 `winston/*` secrets**, scheduled for deletion with a 7-day recovery window: **recoverable until 2026-11-01**, gone after. Four were set by hand (the bot token, the OpenRouter key, the Google client and the Cloudflare token), and `bun run prod:keys` asks for them again on the way back.

  ```sh
  aws secretsmanager restore-secret --secret-id winston/<name> --profile winston-prod
  ```

Not deleted: the `artifacts` bucket (11 GB of VM binaries, about $0.26 a month). Emptying it is safe (S3 console → Empty), since a deploy publishes the binaries again.

**Cloudflare:** the Workers for Platforms plan ($25 a month) is cancelled by hand in the dashboard (Billing → Subscriptions). Until it is, the site on `runwinston.app` keeps serving, since it runs on Cloudflare, not AWS.

## While paused

- **Cost:** about $2–3 a month on AWS (the two KMS keys at $1 each, the snapshots, S3 and ECR), plus the domains' renewals at Cloudflare (about $49 a year for all three).
- Messages to @RunWinstonBot go unanswered, and `runwinston.com` and sign-in are down.
- `bun run prod …` doesn't work, since there's no cluster or `ops` task to run it on.
- **Don't run the deploy workflow** (`gh workflow run ci.yml`) except to bring Winston back by the steps below. The Data stack still describes the deleted database, so a plain deploy would bring the services back (about $95 a month) pointed at a database and a secret that don't exist. Pushes to `main` only run the checks, and the local stack is unaffected, so work can carry on.
- Google mail and calendar tokens expire after 7 days in Testing mode (google-cloud.md), and Gmail and Calendar push stops when their watches lapse, so those connections need reconnecting on the way back.

## How it was done

In this order, which matters:

1. Scale the four services to 0 (`aws ecs update-service … --desired-count 0`) and wait until none run, so nothing writes to the database.
2. Delete the Services stack: `aws cloudformation delete-stack --stack-name winston-services`. Its secrets and log groups are retained.
3. Stop the VM and snapshot its data volume with the volume's tags, wait for the snapshot to complete, then terminate the instance and delete the data volume:

   ```sh
   aws ec2 create-snapshots --instance-specification InstanceId=<id>,ExcludeBootVolume=true --copy-tags-from-source volume --profile winston-prod
   ```

   Adding a `Name` tag with `--tag-specifications` fails, since the volume already has one.

4. Turn off the database's deletion protection, then delete it with a final snapshot: `aws rds delete-db-instance --db-instance-identifier <id> --final-db-snapshot-identifier winston-paused-2026-10`.
5. Only after the stack is gone, schedule the `winston/*` secrets for deletion. Doing it earlier fails the stack's deletion: the load balancer's web rule reads `winston/cloudfront-origin-header` through a dynamic reference, even to be deleted.
6. Deregister the VM images with `--delete-associated-snapshots`, and delete the nightly snapshots (tagged `aws:dlm:lifecycle-policy-id`), keeping the new one.

## Bringing it back

Not yet tried end to end, so check each step's result. Log in first with `aws sso login --profile winston-prod`.

1. **Secrets.** After 2026-11-01 there's nothing to do, since the deploy creates them again. Before then they still exist (scheduled for deletion), and the deploy can't create secrets whose names are taken: restore each one and delete it with `--force-delete-without-recovery`, or wait.
2. **Cloudflare.** Subscribe to Workers for Platforms again, and check that the `winston-sites` dispatch namespace and the routes KV are still there; recreate them from sites.md if not.
3. **The database, through the Data stack.** In `infra/src/data.ts`, make the database a restore of `winston-paused-2026-10` (CDK's `DatabaseInstanceFromSnapshot`), keeping its other settings and `manageMasterUserPassword`. CloudFormation then replaces the deleted instance with one restored from the snapshot, with a new RDS-managed secret, and the stack's exports (endpoint and secret ARN) follow it. Nothing imports them while the Services stack is gone, so they're free to change. Check that `AWS_PROFILE=winston-prod bun run infra:diff` shows the database replaced and nothing else in Data changing.
   - **Keep the snapshot identifier in the code from then on.** Once an instance is restored from `DBSnapshotIdentifier`, CloudFormation needs the same value in every later update: removing it replaces the database with an empty one.
4. **Deploy, rebuilding the VM image** (the one `/winston/vm-ami` names is gone):

   ```sh
   gh workflow run ci.yml --ref main -f vm_image=true
   ```

   It deploys every stack (Data's restore before Services is created), runs migrations on the restored database, publishes the VM binaries and deploys the dispatch Worker (deploys.md).

5. **DNS.** The load balancer and CloudFront are new, so update the three service records in Cloudflare from the Services stack's outputs (dns.md): `@` to `Services.DistributionDomainName`, and `api` and `gateway` to `Services.LoadBalancerDnsName`. The certificate's validation records don't change (the Edge stack was kept).
6. **Keys:** `bun run prod:keys` (secrets.md) for the bot token, the OpenRouter key, the Google client and the Cloudflare token. Once the DNS records resolve, it also registers the Telegram webhook.
7. **The VM:** `bun run prod vm:restore <email>` (vm-recovery.md). The `vms` row still says `ready`, with the deleted instance. Restore makes a volume from the user's newest data snapshot (`snap-0f5e33d8a18b782ff`) and launches a new instance on it; an old instance or volume that's already gone counts as deleted.
8. **Connections and sites:** reconnect Google (and anything else shown as expired) on `runwinston.com`. If Cloudflare removed the site Workers with the plan, ask Winston to deploy the site again; its files are on his restored computer, and its bundles are in `blobs`.
9. **Check:** a message to the bot gets an answer, `bun run prod sql "select state, instance_id from vms"` shows the VM `ready`, and `bun run prod costs` shows spend again. Then remove the paused notes from production.md, costs.md and docs/design.md §19, and keep this runbook for the next pause.
