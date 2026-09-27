---
id: "8d94b2"
title: Deliver Telegram reactions to Winston
status: todo
priority: none
labels:
  - m1
  - telegram
created_at: 2026-09-27T05:30:55.101Z
updated_at: 2026-09-27T05:30:55.149Z
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
