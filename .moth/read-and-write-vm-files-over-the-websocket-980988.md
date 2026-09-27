---
id: "980988"
title: Read and write VM files over the websocket
status: todo
priority: none
labels:
  - m2
  - vm
created_at: 2026-09-27T05:32:51.475Z
updated_at: 2026-09-27T05:32:51.506Z
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
