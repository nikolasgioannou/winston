---
id: "9751a9"
title: Manage the GCP Pub/Sub setup with Terraform
status: todo
priority: none
labels:
  - infra
  - m7
  - tooling
created_at: 2026-09-27T05:40:24.303Z
updated_at: 2026-09-27T05:40:24.358Z
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
