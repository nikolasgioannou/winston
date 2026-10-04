---
id: "22672b"
title: Stop showing Winston's interim text as Telegram drafts
status: done
priority: none
labels:
  - agents
  - telegram
created_at: 2026-10-04T01:26:29.950Z
updated_at: 2026-10-04T01:28:29.382Z
---

The founder doesn't like the passing statuses from feebd3 (decision #75): Telegram drafts that animate in place while Winston works. A message should arrive whole once it exists, with the typing indicator in between.

## Change

- **No drafts.** Remove `showStatus` and `sendRichMessageDraft`. Text the front of house writes beside a tool that does work (`bash`, `view_image`) is held, not shown.
- **Unchanged:** text with no tool call, or beside `end_turn`, `browser_handoff`, `delegate` or `attach`, is a message as before. The typing indicator runs between messages.
- **Never silent:** a turn that sends no message sends its last held text when it ends silently, emptily, or by delegating on its last step (same rule as feebd3, with held text in place of the status).
- **Prompt:** "Replying" says text written while working isn't shown, so put what the user needs in a message.

Docs: §4 (live-editing, Processing without responding), decision #75 superseded by a new one, docs/research/telegram-rich-messages.md.

Tests: interim text sends nothing and the final text is the only message; a turn that ends with only held text sends it; a dropped step forgets its held text.
