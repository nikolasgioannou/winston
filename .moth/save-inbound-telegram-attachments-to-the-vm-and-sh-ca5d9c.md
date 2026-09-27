---
id: "ca5d9c"
title: Save inbound Telegram attachments to the VM and show them to the model
status: todo
priority: none
labels:
  - agents
  - m2
  - telegram
created_at: 2026-09-27T05:32:51.948Z
updated_at: 2026-09-27T05:32:52.003Z
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
