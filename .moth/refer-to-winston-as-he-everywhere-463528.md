---
id: "463528"
title: Refer to Winston as he everywhere
status: backlog
priority: none
labels:
  - m3
  - web
created_at: 2026-09-30T22:21:08.280Z
updated_at: 2026-09-30T22:21:21.481Z
blocked_by:
  - "6341c5"
---

The founder's feedback after M3: Winston is "he" and "him", never "it".

Sweep every user-facing string: web pages (e.g. Home's "Winston's own computer, for its work and your files", "Message it in Telegram"), toasts and notices, the bot's canned Telegram replies in `api`, and any job messages. Fix strays in docs too. The front-of-house prompt addresses Winston as "you" and needs no change. A grep for `\bit\b`/`\bits\b` near "Winston" helps, but read each hit.

Done autonomously with the rest of this batch; the founder reviews it all at the end.
