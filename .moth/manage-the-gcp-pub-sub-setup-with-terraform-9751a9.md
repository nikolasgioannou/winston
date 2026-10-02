---
id: "9751a9"
title: Manage the GCP Pub/Sub setup with Terraform
status: done
priority: none
labels:
  - infra
  - m7
  - tooling
created_at: 2026-09-27T05:40:24.303Z
updated_at: 2026-10-02T00:36:14.555Z
blocked_by:
  - "e1a361"
  - "ef5b35"
---

Gmail push notifications only exist through Google Cloud Pub/Sub, so the Winston GCP project needs a topic and push subscriptions. CDK can't manage GCP, so this small footprint is Terraform in `infra/gcp` (docs/design.md §3, How change notifications arrive; §19).

This introduces Terraform, so research it properly first:
- Pinning Terraform through mise.
- The `google` provider and authenticating locally (gcloud application-default credentials, or a service account; avoid key files in the repo).
- **Remote state:** an S3 backend in `winston-prod` vs a GCS bucket. Pick one with locking and justify it.
- Structuring the module for two environments: prod, and dev pointing at the tunnel.

Resources:
- Enable the Pub/Sub API.
- A topic `gmail-push` (plus a dev topic).
- A Publisher binding for `gmail-api-push@system.gserviceaccount.com` on each topic.
- **Push subscriptions:** prod to `https://api.runwinston.com/webhooks/gmail`, and dev to the tunnel URL, each with **OIDC authentication** using a dedicated service account and an audience we verify. Set sensible retry and backoff and a dead-letter policy.

Write `docs/runbooks/gcp-terraform.md` covering init, plan and apply. Apply prod and dev. CI integration isn't needed. Changes here are rare and applied by hand, which the runbook should say.

## Progress (left in progress)

Written, not yet applied:

- `infra/gcp/modules/gmail-push` with `infra/gcp/prod` and `infra/gcp/dev` roots; `docs/runbooks/gcp-terraform.md`; Terraform 1.16.4 pinned in `mise.toml`; the HashiCorp Terraform editor extension; `.terraform/` ignored.
- Remote state: S3 in `winston-prod` (a bucket in the Ci stack, versioned, native lock file), chosen over GCS because nothing has to be created by hand first and it sits with the rest of Winston's infrastructure. Reasons in the runbook.

Waiting on the founder (needs their Google sign-in, and installing Terraform and the Google Cloud CLI on their machine):

1. `mise install` and install the Google Cloud CLI.
2. `gcloud auth application-default login` and `aws sso login --profile winston-prod`.
3. `terraform init && terraform apply` in `infra/gcp/prod` and `infra/gcp/dev`; commit the generated `.terraform.lock.hcl` files.
4. Set `GMAIL_PUSH_TOPIC`, `GMAIL_PUSH_SERVICE_ACCOUNT` and `GMAIL_PUSH_AUDIENCE` from `terraform output` (production values in the Services stack, dev in `.env.local`).

Then move this ticket to done.

**Applied (2026-10-01)** by the founder, prod and dev; lock files committed. The Gmail publisher binding first failed on the organization's Domain restricted sharing policy; lifted for the project during the apply and restored (now in the runbook). Prod outputs match the Services stack's values; the production Gmail watch was set up by the next `watch_connection` retry.

