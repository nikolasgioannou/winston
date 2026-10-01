---
id: "2ca5a6"
title: Wire production secrets and the KMS token vault
status: done
priority: none
labels:
  - backend
  - infra
  - m4
created_at: 2026-09-27T05:36:32.611Z
updated_at: 2026-10-01T05:03:50.064Z
blocked_by:
  - "35fdd4"
  - "f25d3b"
---

Production secrets live in Secrets Manager, and each service gets **only its own** (docs/design.md §12a).

Define in CDK (values set out of band, never in code):
- OpenRouter API key, TypeSafe Jev key, production Telegram bot token and webhook secret.
- Google OAuth client id and secret (prod).
- The internal gateway secret, the run-token signing secret, the session secret.

Map which service needs which. For example, `web` never sees the Telegram token, and `gateway` never sees OpenRouter. The Services stack will inject them as environment variables through task definitions. Write the mapping as data in CDK so it's reviewable at a glance.

Implement the **KMS envelope encryption** vault behind the interface from the connections ticket:
- `GenerateDataKey` for encryption, with the encrypted data key stored alongside the ciphertext.
- `Decrypt` for reading, with reasonable data-key caching.
- Select the implementation by environment.
- Grants (the keys exist in the data stack, with key policies that delegate to IAM): `api` and `agents` get `kms:Decrypt` and `kms:GenerateDataKey` on the tokens key; `web` gets only `kms:GenerateDataKey`, since it stores tokens when an account is connected but never reads them.

Provide `docs/runbooks/secrets.md`: how to set or rotate each secret value with the AWS CLI.

Tests: the KMS vault against a mocked KMS client (round trip, tampering), and a CDK assertion that each task definition references only its allowed secrets.

**Done (2026-10-01):** the secrets exist only for what the code reads today (no session secret, since sessions are Postgres rows, and no Jev key until Jev is wired). Task definitions don't exist yet, so the per-task-definition secrets assertion and the KMS grants moved to the Fargate ticket (071e49).
