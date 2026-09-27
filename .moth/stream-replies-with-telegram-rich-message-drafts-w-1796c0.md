---
id: "1796c0"
title: Stream replies with Telegram rich message drafts (with the founder)
status: todo
priority: none
labels:
  - collab
  - m9
  - telegram
created_at: 2026-09-27T23:08:56.633Z
updated_at: 2026-09-27T23:09:11.231Z
blocked_by:
  - "d3a1a9"
---

Telegram's Bot API 10.1 added `sendRichMessageDraft`: in private chats a bot can stream a partial rich message that the user sees being written (an ephemeral preview for about 30 seconds, finalized by `sendRichMessage`). See docs/research/telegram-rich-messages.md.

Today the design deliberately doesn't stream: replies go out once complete, a typing indicator shows work, and a draft is discarded if new input arrives while it's written (docs/design.md §4, Steering; decision #14). Streaming changes that trade-off, so decide it together with the user.

Research and prototype first:
- How drafts behave exactly: update frequency limits, what the user sees when a draft is abandoned (for example after a dropped stale reply or a `no_reply`), how a draft is replaced by the final message, and whether it works on all clients.
- How it fits our turn loop: streaming the final step's text (`streamText` through the gateway, with model-call recording intact), never streaming narration beside tool calls, and what happens to a streamed draft when steering drops it.
- Whether streaming still earns its keep for short replies, or only for long ones (for example, start streaming only once a reply passes some length).

Then, with the user, decide whether to adopt it, and if so implement it behind the existing delivery path, update §4 and the decision log (revisiting #14), and keep the typing indicator for silent or tool-only stretches.
