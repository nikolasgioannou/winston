---
id: "22f09d"
title: Delete an account and everything in it
status: todo
priority: none
labels:
  - backend
  - m3
  - web
created_at: 2026-09-27T05:34:41.162Z
updated_at: 2026-09-27T05:34:41.231Z
blocked_by:
  - "0a5f39"
  - "89a2b0"
  - "988f4d"
---

Deleting an account wipes everything: the computer, all data and all tokens (product.md §1, docs/design.md §13 account deletion, §17).

`/profile/delete` explains exactly what will be deleted, requires typing a confirmation, then starts a `delete_user` job and signs the user out. The job:
1. Destroys the VM through the `VmProvider`, including the data volume and any snapshots. The EC2 specifics arrive in M4, and the provider interface should already cover it.
2. Revokes every connected Google token.
3. Deletes stored blobs. S3 in production. Locally, whatever stand-in the view-image ticket chose.
4. Deletes all rows for the user, across every table with a `user_id`.
5. Removes the Telegram link. Decide whether Winston sends a final "goodbye" message first. Probably yes, briefly.

The job must be **idempotent and resumable**: if it dies halfway, a retry finishes the job without erroring on already-deleted things. The allowlist entry stays, since that's the founder's decision, not the user's.

Guard against missing a table later: add a test that enumerates every table with a `user_id` column from the schema and asserts that deletion leaves zero rows in each. That catches future tables that forget to join the deletion.

Add the page's states to the dev design view.
