# GCP with Terraform

Winston's Google Cloud footprint beyond the OAuth clients (docs/runbooks/google-cloud.md) is Gmail push: a Pub/Sub topic Gmail publishes to, and a push subscription that delivers each notification to our webhook (docs/design.md §3, How change notifications arrive). CDK can't manage GCP, so it's Terraform in `infra/gcp`. Changes are rare and **applied by hand**; CI doesn't run Terraform.

## What's there

| Path                           | What                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/gcp/modules/gmail-push` | The Pub/Sub API, the topic, Gmail's publisher binding, the push subscription (OIDC, backoff 10–600 s, 10 attempts) and its dead-letter topic |
| `infra/gcp/prod`               | Topic `gmail-push`, pushing to `https://api.runwinston.com/webhooks/gmail`                                                                   |
| `infra/gcp/dev`                | Topic `gmail-push-dev`, pushing to `https://dev.runwinston.com/webhooks/gmail` (the local tunnel)                                            |

Both live in the `winston-510100` project. Each root has its own state in S3: `s3://winston-terraform-state-766577085959/gcp/<env>.tfstate`, created by the Ci stack, versioned, with S3's native lock file (`use_lockfile`).

## Before the first run

1. **Terraform:** it's pinned in `mise.toml`; `mise install` (or `scripts/setup.sh`) installs it.
2. **Google Cloud CLI:** install it ([cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)), then sign in as the project's owner and make those credentials available to Terraform. No key files: Terraform uses the application-default credentials.

   ```bash
   gcloud auth application-default login
   ```

3. **AWS:** the S3 backend uses the `winston-prod` profile, so sign in first (docs/runbooks/aws-access.md).

   ```bash
   aws sso login --profile winston-prod
   ```

## Plan and apply

For each environment (`prod`, then `dev`):

```bash
cd infra/gcp/prod
terraform init
terraform plan
terraform apply
```

Commit `.terraform.lock.hcl` after the first `init` (it pins the provider's checksums); `.terraform/` is ignored.

`terraform output` prints the three values the app needs:

| Output                 | Setting                      | Where                                                                       |
| ---------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `topic`                | `GMAIL_PUSH_TOPIC`           | `gateway` and `api` (production: the Services stack; locally: `.env.local`) |
| `push_service_account` | `GMAIL_PUSH_SERVICE_ACCOUNT` | `api`, which verifies the push requests' OIDC tokens                        |
| `audience`             | `GMAIL_PUSH_AUDIENCE`        | `api`                                                                       |

## Choices

- **State in S3, not GCS.** Everything else Winston runs is in `winston-prod`, where we already sign in, and the bucket comes from CDK on the next deploy, so nothing has to be made by hand before Terraform can run. S3 has native locking since Terraform 1.10, so no DynamoDB table either. A GCS bucket would have needed creating by hand first.
- **Two roots, one module**, rather than workspaces: each environment's state and values are explicit in its own directory, and you can't apply to the wrong one by forgetting which workspace is selected.
- **OIDC push, audience = the endpoint.** The webhook checks the token's issuer, audience and service-account email. The Pub/Sub service agent gets Token Creator on the push service account (needed to mint the tokens; harmless where Google already grants it).
- **Dead letters** go to `<topic>-dead-letter`, kept a week by a subscription. The reconciliation sweep catches anything a dead letter missed, so they're for looking at, not replaying.
