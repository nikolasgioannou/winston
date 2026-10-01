---
id: "463528"
title: Refer to Winston as he everywhere
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-09-30T22:21:08.280Z
updated_at: 2026-10-01T00:36:00.153Z
blocked_by:
  - "6341c5"
---

The founder's feedback after M3: Winston is "he" and "him", never "it".

Sweep every user-facing string: web pages (e.g. Home's "Winston's own computer, for its work and your files", "Message it in Telegram"), toasts and notices, the bot's canned Telegram replies in `api`, and any job messages. Fix strays in docs too. The front-of-house prompt addresses Winston as "you" and needs no change. A grep for `\bit\b`/`\bits\b` near "Winston" helps, but read each hit.

Done autonomously with the rest of this batch; the founder reviews it all at the end.

## Outcome

- Swept web pages, toasts, the bot's canned Telegram replies, job messages, the prompt and docs for "it"/"its" meaning Winston. In the product, only Home's computer copy did ("its work", "its own computer", "its computer"), now "his"; the header subtexts that said "Message it in Telegram" were already removed in 75bfa7. Every other hit uses "it" for an account, file, the computer or a package, or is the prompt addressing Winston as "you".
- design.md: "Winston gets its own AWS account" and "Winston has its own AWS account" now say Winston runs in a dedicated AWS account.

