---
id: "68fe0c"
title: Let send_message deliver files from the VM
status: todo
priority: none
labels:
  - agents
  - m2
  - telegram
created_at: 2026-09-27T05:32:52.019Z
updated_at: 2026-09-27T05:32:52.067Z
blocked_by:
  - "980988"
  - "ed1e47"
---

Winston can send photos and files from his computer, for example a screenshot of a booking confirmation or a downloaded PDF (docs/design.md §4 Media).

Extend `send_message` with optional `attachments: string[]` of VM paths:
- Read each file through gateway's file API and upload it to Telegram. Images go as photos (unless they're huge, in which case send as a document to avoid compression). Everything else goes as a document.
- Telegram's upload limit for bots is 50 MB. Reject larger files with an error the model can explain.
- Several attachments go as a media group where Telegram allows mixing, otherwise as separate messages.
- Captions are limited to 1,024 characters. Longer text goes as a follow-up message (§4, Telegram formatting).
- Record the Telegram file ids on the `outbound_messages` row.

Tests with a fake Telegram client: photo vs document selection, caption overflow, media groups, oversize rejection, and a missing path producing a clear tool error.
