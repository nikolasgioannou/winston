---
id: "ca5d9c"
title: Save inbound Telegram attachments to the VM and show them to the model
status: done
priority: none
labels:
  - agents
  - m2
  - telegram
created_at: 2026-09-27T05:32:51.948Z
updated_at: 2026-09-28T03:20:44.367Z
blocked_by:
  - "980988"
  - "cb9674"
---

Photos, screenshots, documents and any other files the user sends become files on Winston's computer. Readable ones also go straight to the model (product.md §2, docs/design.md §4 Media).

Handle Telegram message types with attachments: photo (pick the largest size), document, video, audio, animation, and captions. Voice notes are the next ticket.

The webhook stores the item quickly. Downloading happens in a job, so the webhook stays fast:
1. Download via the Bot API (`getFile`, then the file URL). Research the 20 MB download limit for bots, and handle files over it with a clear message to the user.
2. Write to `~/inbox/<YYYY-MM-DD>/<safe-filename>` on the VM through the file API. Avoid collisions.
3. Record a `files` row.

The envelope lists each file's path, type and size. For images, PDFs and text files, the front-of-house turn also attaches the content as a model content block. Research how Claude via OpenRouter and the AI SDK accepts PDFs and images, and the size limits.

Ordering matters: the turn must not start before the files are in place. Hold the item until its downloads finish, then enqueue the turn.

Tests: each message type maps to the right stored item and envelope, filename sanitization, the oversize path, and turn enqueueing waiting for downloads.

## Outcome

- The webhook stores a file message as a `pending` item with its `attachment` and queues `save_attachment`. The job downloads the file, reserves a collision-free name under `~/inbox/<local date>/` (noclobber, remembered for retries), writes it, prepares what the model is shown (images via `view_image`'s conversion; PDFs ≤ 10 MB and ≤ 20 pages; text ≤ 50 KB), records a `files` row, then releases the item and queues the turn. Turns only claim input older than the oldest pending item, so order is kept.
- Over 20 MB (known size, or `getFile`'s "file is too big") becomes `too_large`; the last failed attempt becomes `failed`. Either way the message is released and the envelope says why.
- The image gained `poppler-utils` (`pdfinfo`, `pdftotext`).
- Verified live: a captioned photo (described from the image), a 37-page PDF (saved, over the page limit, so Winston read it with `pdftotext`), a Markdown file (shown as text) and a 52 MB video (told it's over the 20 MB limit). All landed in `~/inbox/2026-09-27/`. Short-PDF display is covered by tests only.
