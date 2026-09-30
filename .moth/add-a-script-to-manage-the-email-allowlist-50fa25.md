---
id: "50fa25"
title: Add a script to manage the email allowlist
status: done
priority: none
labels:
  - backend
  - m3
  - tooling
created_at: 2026-09-27T05:34:41.248Z
updated_at: 2026-09-30T05:08:28.142Z
blocked_by:
  - "244f55"
---

Friends are added to Winston by inserting rows into `allowed_emails`, with no admin UI (docs/design.md §5, Access control). Make that safe and easy with `bun run allowlist add|remove|list <email>`, working against the local DB, and against production once M4 exists (through an ECS one-off task or a secure tunnel to RDS, whichever the production tickets set up).

Behaviour:
- Emails are normalized (lowercased, trimmed) and validated.
- `remove` doesn't delete an existing user. It prevents future sign-ins. Say so in the output.
- It prints a reminder of the Google gotcha: the email must also be added as a **test user** on the Google OAuth consent screen, or sign-in and connections will fail.

Tests: normalization, and add/remove idempotency.

## Outcome

- `bun run allowlist list | add <email> | remove <email>` on `@winston/db/allowlist`. It names the database it's using first, since the production path (`bun run prod allowlist …`) comes with 1867ba in M4.
- Emails are trimmed, lowercased and validated; add and remove are idempotent. `remove` says the user can't sign in any more, and when they already have an account, that it stays (only its owner deletes it).
- The reminder follows the runbook rather than this ticket's wording: signing in only needs the allowlist, but connecting mail or calendar needs the address (and any other account they'll connect) on Google's test-user list.
- docs/local-dev.md shows how to allowlist someone locally.
- Tests: normalization and validation, add/remove idempotency, and `remove` reporting a remaining account. Tried every command against the local database.

