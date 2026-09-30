---
id: "22f09d"
title: Delete an account and everything in it
status: done
priority: none
labels:
  - backend
  - m3
  - web
created_at: 2026-09-27T05:34:41.162Z
updated_at: 2026-09-30T05:03:58.618Z
blocked_by:
  - "0a5f39"
  - "89a2b0"
  - "988f4d"
---

Deleting an account wipes everything: the computer, all data and all tokens (product.md §1, docs/design.md §13 account deletion, §17).

A **Delete account** section on `/profile` (not a separate page or sidebar item; the founder's call) explains exactly what will be deleted, requires typing a confirmation in a dialog, then starts a `delete_user` job and signs the user out. The job:
1. Destroys the VM through the `VmProvider`, including the data volume and any snapshots. The EC2 specifics arrive in M4, and the provider interface should already cover it.
2. Revokes every connected Google token.
3. Deletes stored blobs. S3 in production. Locally, whatever stand-in the view-image ticket chose.
4. Deletes all rows for the user, across every table with a `user_id`.
5. Removes the Telegram link. Decide whether Winston sends a final "goodbye" message first. Probably yes, briefly.

The job must be **idempotent and resumable**: if it dies halfway, a retry finishes the job without erroring on already-deleted things. The allowlist entry stays, since that's the founder's decision, not the user's.

Guard against missing a table later: add a test that enumerates every table with a `user_id` column from the schema and asserts that deletion leaves zero rows in each. That catches future tables that forget to join the deletion.

Add the page's states to the dev design view.

## Outcome

- **Delete account** on `/profile`: what's deleted, a confirmation that needs "delete" typed (`ConfirmDialog` gained `confirmText`), then `requestAccountDeletion` marks the user (`users.deletion_requested_at`, which blocks sign-in), ends their sessions and queues `delete_user`; the site signs them out to `/?deleted=1`, where sign-in says the account was deleted.
- `delete_user` in `agents`, idempotent and resumable: drops their queued jobs, says a brief goodbye in Telegram (decided: yes, one line, best effort) and unlinks, terminates the VM through `VmProvider` (new `destroyDataVolume`; Docker removes the named volume, and EC2 will delete the EBS volume and snapshots), revokes every Google grant, deletes the blobs only they refer to (new `BlobStore.delete`; shared content-addressed blobs stay), then deletes the user row. The allowlist entry stays.
- The job has no `user_id`, so it survives the cascade it causes.
- Guard: a test reads the database catalog and fails if any `user_id` column lacks an `ON DELETE CASCADE` reference to `users`; another fills a user across the tables and asserts zero rows in every schema table with a `user_id` after deletion.
- Dev design view: the delete confirmation on Profile, the deleted notice on sign-in.
- Tests: the catalog guard, full deletion (goodbye, VM and volume, revocation, blobs, zero rows, allowlist kept), a shared blob kept, a retry after a failure part-way finishing without repeating done steps, a second run doing nothing, requesting deletion (marker, sessions, one job without `user_id`), and sign-in refused while deleting.
- Checked live: a throwaway user with a real local VM, deleted from its Profile page (the confirm button stayed disabled until "delete" was typed); the job finished, and the rows, container and volume were gone.

