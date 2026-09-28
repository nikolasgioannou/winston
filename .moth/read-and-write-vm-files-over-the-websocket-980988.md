---
id: "980988"
title: Read and write VM files over the websocket
status: done
priority: none
labels:
  - m2
  - vm
created_at: 2026-09-27T05:32:51.475Z
updated_at: 2026-09-28T00:37:55.130Z
blocked_by:
  - "6bde95"
---

Several features move files between the backend and the VM: inbound Telegram attachments are written into the VM's inbox, `view_image` reads screenshots, and outbound attachments are read from VM paths (docs/design.md §4 Media, §15 `file.read`/`file.write`).

Add `file.read` and `file.write` frames:
- Chunked transfer, so large files (up to Telegram's 50 MB bot limit) don't blow the websocket's max frame size.
- File operations run as the `winston` user and are confined to `/home/winston`. Reject paths that escape it, including via symlinks.
- Writes create parent directories, and are atomic (write to a temp file, then rename).

Expose them on gateway's internal API: `GET /internal/vms/:userId/files?path=` and `PUT` equivalently, streaming where Bun makes it easy.

Tests:
- Round-trip integrity (hash comparison) for small and multi-chunk files.
- Traversal and symlink escapes rejected.
- An atomic write never leaves a partial file on failure.

## Outcome

Built as described in docs/design.md §15 (winstond: "Files").
- **Running as `winston`:** `winstond` re-invokes its compiled binary in a helper mode through the same sudo rule as exec, so there's no second privileged mechanism and the confinement logic stays testable TypeScript.
- **Transfer:** chunked (256 KiB, base64), with SHA-256 end to end and a 50 MB cap. Writes are atomic and verified before the rename. Reads stream once the first bytes arrive.
- **Error codes:** added `permission_denied`, for a link that can't be followed and doesn't point outside.
- **Tests:** round trip for small and multi-chunk files, traversal and symlink escapes, atomic failure with no leftovers, and gateway streaming, errors, uploads and drops.
- **End to end in the real VM:** round trip, ownership, escapes (including a symlink to the token), and persistence across re-provisioning.
