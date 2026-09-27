---
id: "a4de0d"
title: Store screenshots and attachments in S3 in production
status: todo
priority: none
labels:
  - backend
  - infra
  - m4
created_at: 2026-09-27T05:42:59.180Z
updated_at: 2026-09-27T05:42:59.238Z
blocked_by:
  - "68e9cc"
  - "f25d3b"
---

Large binaries (browser screenshots, image content blocks, attachments referenced from the model-call log) are kept out of Postgres. They go to blob storage and are referenced by key (docs/design.md §12). The view-image ticket chose a local stand-in and a blob-store interface. This ticket adds the production implementation on the `blobs` S3 bucket from the data stack.

- An S3 implementation of the blob interface: `put` (content-addressed keys, for example by SHA-256, so identical screenshots are stored once), `get`, and `delete`. Key prefixes are per user, so account deletion can remove everything under a user's prefix.
- The IAM task roles for services that read or write blobs are scoped to that bucket. Only `agents` and `gateway` should need it. Confirm which.
- Select the implementation by environment.
- Hook account deletion (the delete ticket) into the S3 prefix removal, if it isn't already generic over the interface.

Research sensible S3 settings for this use: storage class, a lifecycle rule for old run screenshots (the log should still be reconstructable, so decide on retention with the founder in mind, and note it in §12), and server-side encryption.

Tests: the S3 implementation against a mocked S3 client (put, get, delete, per-user prefix deletion), and content-addressed deduplication.
