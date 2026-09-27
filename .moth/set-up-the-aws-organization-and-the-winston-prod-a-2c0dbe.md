---
id: "2c0dbe"
title: Set up the AWS Organization and the winston-prod account (with the founder)
status: todo
priority: none
labels:
  - collab
  - infra
  - m4
created_at: 2026-09-27T05:36:32.229Z
updated_at: 2026-09-27T05:36:32.263Z
blocked_by:
  - "0fa82e"
---

Winston gets its own AWS account, `winston-prod`, inside an AWS Organization, fully separate from the founder's other projects. Access goes through IAM Identity Center with short-lived credentials (docs/design.md §8, Account isolation).

**This changes the founder's AWS account outside the project. Get explicit approval before doing anything.** Walk through each step with them, since most of it happens in their console:
- Create the Organization, with the existing account as the management account. Research what enabling Organizations changes for an existing account (consolidated billing, SCP availability) and explain it first.
- Create the `winston-prod` member account.
- Enable IAM Identity Center. Create a user for the founder and a permission set for administering `winston-prod`.
- Configure the AWS CLI locally with an SSO profile (`aws configure sso`). The AWS CLI is pinned in `mise.toml`, not installed globally, so add it there as part of this ticket.
- Confirm `aws sts get-caller-identity --profile winston-prod` works.

Write `docs/runbooks/aws-access.md`: how to log in (`aws sso login`), the profile name, and which account ids are which. Don't write any credentials into the repo.
