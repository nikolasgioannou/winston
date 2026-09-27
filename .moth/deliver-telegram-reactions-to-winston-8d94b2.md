---
id: "8d94b2"
title: Deliver Telegram reactions to Winston
status: done
priority: none
labels:
  - m1
  - telegram
created_at: 2026-09-27T05:30:55.101Z
updated_at: 2026-09-27T22:35:16.471Z
blocked_by:
  - "db2a16"
  - "e47a50"
---

A 👍 or 👎 on one of Winston's messages is cheap, useful feedback ("stop sending me these"). It arrives as the always-delivered event `telegram.reaction.added` (docs/design.md §3, event catalog).

Research how Telegram delivers reactions to bots: the `message_reaction` update, which must be explicitly requested in `allowed_updates`, and whether it works in private chats. Update the webhook registration script accordingly.

On a reaction to one of Winston's messages:
- Store an inbound item with the emoji and a reference to the target message: the `outbound_messages` row and its text snippet, so the envelope gives the model context.
- Queue a front-of-house turn like any other input.
- Winston will usually stay silent after a reaction, so make sure the first-draft prompt mentions that reacting isn't a request for a reply.

Ignore removed reactions. Store a changed reaction as a new item.

Tests: fixture updates render into the expected envelope, and reactions to unknown messages are handled gracefully.

## Outcome

Built as described in docs/design.md §4 ("Telegram inbound", Reactions). Checked live with the user: a 👍 in the private chat arrived, was stored with its target snippet, and produced a silent one-step turn.
- **Scope:** only emoji reactions count, not custom or paid ones.
- **Unknown targets:** reactions to messages Winston didn't send are dropped with a log line, since there's no target to give the model context.
- **Rendering:** the generic event envelope with the payload as JSON `<data>`.
- **Webhook registration:** `allowedUpdates` now includes `message_reaction`, and the dev webhook was re-registered.
