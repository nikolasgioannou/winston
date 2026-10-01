---
id: "d66d10"
title: Send, reply, forward and organize mail via Gmail
status: done
priority: none
labels:
  - connectors
  - m5
created_at: 2026-09-27T05:37:39.234Z
updated_at: 2026-10-01T16:29:24.848Z
blocked_by:
  - "6af84b"
---

The write side of the Gmail provider (docs/design.md §11 `winston mail`, §5 Permissions). Each operation checks its capability:
- `send`/`reply`/`forward` need `send`.
- `--draft` needs `draft`.
- `update`/`delete` need `modify_labels`.

Research building correct MIME messages (a library like `mimetext` or nodemailer's composer, and whether it works on Bun): multipart with attachments, UTF-8 headers (RFC 2047), and for **replies**, correct `In-Reply-To`/`References` headers and `threadId`, so replies land in the same thread for everyone. Reply-all semantics are included (dedupe recipients, exclude the user's own address).

Operations:
- **send** (to, cc, bcc, subject, body, attachments), **reply** (`--all`), **forward** (keep the original's attachments).
- **`--draft` on any of them** creates a draft instead. **send `<drf_id>`** sends an existing draft.
- **update:** read/unread, star/unstar, archive/inbox, add or remove labels (create labels that don't exist? Decide and note it).
- **delete:** moves to trash, **never permanent** (product principle).
- **Attachments** come from VM file paths via the file API.
- **`--dry-run`:** returns exactly what would be sent (from, to, cc, subject, body, attachment names) without sending. It's how agents preview for confirm-first.

Every write goes through the audit log. Tests on the pure parts: MIME output (golden files), reply headers and recipients, and dry-run rendering. Plus provider calls with recorded or mocked API responses.

**Done (2026-10-01):** MIME by nodemailer's MailComposer (works on Bun, no dependencies). Adding a missing label creates it. Deleting a draft trashes its message (Gmail's drafts.delete is permanent). Dry runs check the capability too.
