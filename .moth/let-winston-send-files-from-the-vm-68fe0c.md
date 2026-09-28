---
id: "68fe0c"
title: Let Winston send files from the VM
status: done
priority: none
labels:
  - agents
  - m2
  - telegram
created_at: 2026-09-27T05:32:52.019Z
updated_at: 2026-09-28T04:51:52.254Z
blocked_by:
  - "103e94"
  - "980988"
  - "ed1e47"
---

Winston can send photos and files from his computer, for example a screenshot of a booking confirmation or a downloaded PDF (docs/design.md §4 Media).

The mechanism is decided (decision #70, docs/research/reply-design.md): a native `attach({ paths })` tool, already in invariant 6, that sends the files immediately. Replies are streamed, so the user gets messages and files in the order Winston produces them. Attachments are VM paths:
- Check each path on the VM as the tool is called and return a clear error the model can explain: no such file, a directory, or over Telegram's 50 MB bot upload limit. Nothing is sent if any path fails.
- Read each file through the gateway's file API and upload it to Telegram. Images go as photos (unless they're huge, in which case send as a document to avoid compression). Everything else goes as a document.
- Several files in one call go as a media group where Telegram allows mixing, otherwise as separate messages. No captions: Winston's words are his own messages, sent in order around the files.
- Record each sent file in `outbound_messages` (Telegram message and file ids) and `files`.
- Add `attach` to the front-of-house tools and one line to the prompt, as tested in the eval: "To send the user a file from your computer (a photo, a PDF, anything), call the `attach` tool with its path; it's sent immediately. Up to 10 files, 50 MB each."

Tests with a fake Telegram client: photo vs document selection, media groups, oversize rejection, a missing path producing a clear tool error, and files arriving in order between messages.

## Outcome

- `attach({ paths })` checks every path on the VM first (exists, a file, inside the home folder, 1 byte to 50 MB) and sends nothing if any fails, listing every problem. Images within Telegram's photo limits go as photos, everything else as documents; consecutive files of one kind go as a media group of up to 10. Each sent file gets `outbound_messages` and `files` rows.
- Found in live testing: after the last message, the model's wrap-up call (seeing the `attach` result, then `end_turn`) showed a stray "typing…". The indicator now restarts its clock after every message and file, reappearing only if the turn is still working 4 s later.
- Verified live: a photo sent back as a photo with "Here you go."; a PDF and a README as one document album, then "Sent both."; a missing path answered plainly with nothing sent; "send a message first and then the cat pic" arrived in that order.
