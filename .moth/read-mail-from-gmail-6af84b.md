---
id: "6af84b"
title: Read mail from Gmail
status: done
priority: none
labels:
  - connectors
  - m5
created_at: 2026-09-27T05:37:39.115Z
updated_at: 2026-10-01T16:16:30.648Z
blocked_by:
  - "480aff"
---

The Gmail implementation of `MailProvider`'s read side, behind the VM API routes for list, search, get and download (docs/design.md §11 Command reference, `winston mail`).

Research the Gmail API well first:
- `messages.list` with `q`, `threads.get`, `messages.get` formats (`full` vs `metadata`) and batching to avoid N+1 requests.
- MIME structure: multipart/alternative, nested parts, inline images, encodings, charsets.
- Label ids vs names, and categories. Quotas per method.

Behaviour:
- **list / search:**
  - The portable structured filters (`--from`, `--to`, `--subject`, `--unread`, `--has-attachment`, `--label`, `--category`) and `--in inbox|sent|drafts|archive|all` translate to a Gmail query.
  - `--native "<query>"` passes a Gmail query through as-is.
  - `--since`/`--until` come resolved from the time parser.
  - Results are newest first, with cursor pagination.
- **get:**
  - A message, or a whole thread oldest first.
  - Body as readable **text**: prefer `text/plain`, and otherwise convert HTML to text sensibly (research a solid HTML-to-text library, since newsletters and HTML-only mail are common).
  - Strip quoted reply chains where it's reliable.
  - Attachments listed as `att_` ids with name, type and size.
- **download:** fetch attachments and write them to the VM (`~/downloads` by default) through the file API. Return the paths.

Tests against **recorded Gmail API responses** (fixtures you capture once from a real account, with personal data scrubbed): filter-to-query translation, MIME parsing on tricky real messages, HTML-to-text, and pagination.

**Done (2026-10-01):** fixtures are synthetic, shaped exactly like Gmail's responses, rather than captured from a real account (no one's mail in the repository). Metadata is fetched in parallel instead of through the batch endpoint. Attachments save onto the VM through the gateway's file transfer (frames cap at 1 MiB). The gateway now decrypts tokens (it hosts the VM-facing API).
