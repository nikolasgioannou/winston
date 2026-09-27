---
id: "50fa25"
title: Add a script to manage the email allowlist
status: todo
priority: none
labels:
  - backend
  - m3
  - tooling
created_at: 2026-09-27T05:34:41.248Z
updated_at: 2026-09-27T05:34:41.282Z
blocked_by:
  - "244f55"
---

Friends are added to Winston by inserting rows into `allowed_emails`, with no admin UI (docs/design.md §5, Access control). Make that safe and easy with `bun run allowlist add|remove|list <email>`, working against the local DB, and against production once M4 exists (through an ECS one-off task or a secure tunnel to RDS, whichever the production tickets set up).

Behaviour:
- Emails are normalized (lowercased, trimmed) and validated.
- `remove` doesn't delete an existing user. It prevents future sign-ins. Say so in the output.
- It prints a reminder of the Google gotcha: the email must also be added as a **test user** on the Google OAuth consent screen, or sign-in and connections will fail.

Tests: normalization, and add/remove idempotency.
