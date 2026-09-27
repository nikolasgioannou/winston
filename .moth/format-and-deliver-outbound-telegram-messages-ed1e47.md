---
id: "ed1e47"
title: Format and deliver outbound Telegram messages
status: todo
priority: none
labels:
  - m1
  - telegram
created_at: 2026-09-27T05:30:54.857Z
updated_at: 2026-09-27T05:30:54.887Z
blocked_by:
  - "cb9674"
---

Agents write a small Markdown subset. Telegram's MarkdownV2 escaping is notoriously fragile, so we convert to Telegram's HTML parse mode instead (docs/design.md §4, "Telegram formatting").

Research Telegram's HTML parse mode precisely: supported tags, required escaping of `<`, `>`, `&`, nesting rules, and how links and code are represented. Also the 4,096-character message limit and 1,024-character caption limit, and how the limits count characters (UTF-16 code units vs characters matters for emoji).

Implement:
- A converter from our Markdown subset (bold, italic, inline code, code blocks, links, bullet and numbered lists) to Telegram HTML. Anything outside the subset degrades to escaped plain text rather than breaking.
- Splitting long messages at paragraph boundaries, falling back to line and then hard splits, without ever cutting inside a tag.
- If Telegram rejects the markup, re-send that chunk as plain text and log it.
- Recording all resulting Telegram message ids on the `outbound_messages` row.

This converter is pure and a great fit for thorough unit tests: each construct, nested formatting, escaping edge cases, emoji near the split boundary, and very long code blocks.
