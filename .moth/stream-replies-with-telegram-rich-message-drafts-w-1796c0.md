---
id: "1796c0"
title: Stream replies with Telegram rich message drafts (with the founder)
status: done
priority: none
labels:
  - collab
  - m9
  - telegram
created_at: 2026-09-27T23:08:56.633Z
updated_at: 2026-10-02T18:25:08.142Z
blocked_by:
  - "d3a1a9"
---

Telegram's Bot API 10.1 added `sendRichMessageDraft`: in private chats a bot can stream a partial rich message that the user sees being written (an ephemeral preview for about 30 seconds, finalized by `sendRichMessage`). See docs/research/telegram-rich-messages.md.

Today each message is sent whole once its step's model call ends (replies are streamed message by message, decision #70), a typing indicator shows work between messages, and a message is dropped if new input arrives while it's written (docs/design.md §4, Steering; decision #14). Streaming changes that trade-off, so decide it together with the user.

Research and prototype first:
- How drafts behave exactly: update frequency limits, what the user sees when a draft is abandoned (for example after a message dropped for new input), how a draft is replaced by the final message, and whether it works on all clients.
- How it fits our turn loop: streaming each step's text as it's generated (`streamText` through the gateway, with model-call recording intact), how that fits sending a step's text before its tools run, and what happens to a streamed draft when steering drops it.
- Whether streaming still earns its keep for short replies, or only for long ones (for example, start streaming only once a reply passes some length).

Then, with the user, decide whether to adopt it, and if so implement it behind the existing delivery path, update §4 and the decision log (revisiting #14), and keep the typing indicator for silent or tool-only stretches.

## As built

Decided autonomously at the founder's request (2026-10-02): **not adopted for now**, recorded as decision #72 (revisits #14 and keeps it), with the draft research added to docs/research/telegram-rich-messages.md and §4 updated.

- **How drafts behave** (Bot API 10.3): `draft_id` updates animate in place; the draft is a ~30 s preview that vanishes when the bot sends a message; empty `sendMessageDraft` text shows "Thinking…"; 10.3 adds `can_stop`/`keep_on_stop`; no documented rate limit.
- **Why not now:** the front of house never shows a refused output, and some refusals are a safety filter cutting a response mid-stream, so a draft would show exactly what's meant to stay hidden; replies are mostly a few sentences sent whole within seconds, with the typing indicator meanwhile; a dropped step's draft would linger up to 30 s unless replaced.
- **If revisited:** switch the front of house to `streamText` through the gateway (recording intact), draft only once a reply passes a length threshold, replace a dropped step's draft with a "Thinking…" draft, keep the typing indicator for silent stretches.
