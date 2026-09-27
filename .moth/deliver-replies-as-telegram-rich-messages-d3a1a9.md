---
id: "d3a1a9"
title: Deliver replies as Telegram rich messages
status: done
priority: none
labels:
  - m1
  - telegram
created_at: 2026-09-27T23:08:56.593Z
updated_at: 2026-09-27T23:20:00.841Z
blocked_by:
  - "ed1e47"
---

Telegram's Bot API 10.1 (June 2026) added Rich Messages: `sendRichMessage` accepts standard, GitHub-flavored Markdown directly, with headings, real lists, task lists, tables, quotes, code blocks, spoilers and inline HTML, up to 32,768 characters (docs/research/telegram-rich-messages.md). Today we convert the model's Markdown to Telegram's older HTML parse mode ourselves (`apps/agents/src/telegram/format.ts`), which can't do tables or real lists and must split at 4,096 characters.

A live test from @RunWinstonDevBot rendered everything well on desktop, and deliberately malformed Markdown was accepted and degraded gracefully (literal text), not rejected.

Switch reply delivery to Rich Messages:
- Send the model's reply as `rich_message: { markdown }` via `sendRichMessage`. grammY 1.46 has no typed method yet, so call it through the raw API and keep the call behind the `TelegramSender` interface.
- If Telegram returns an error, re-send as plain text with `sendMessage` and log it, so a reply is never lost.
- Delete the Markdown-to-HTML converter; keep plain-text splitting only for replies over the 32,768-character limit (very rare).
- Record the Telegram message ids on the `outbound_messages` row as today.
- Update the front-of-house prompt: lists and small tables are welcome; no headings in ordinary replies (they render large and heavy in chat); links as Markdown.
- Rich Markdown renders inline HTML, so a stray tag changes formatting. Decide whether to escape `<` in model output before sending, and test it.
- Check rendering on the phone apps (iOS/Android) as well as desktop before calling it done.

Update docs/design.md §4 ("Telegram formatting") and the decision log (supersedes the HTML-parse-mode part of #51).

Tests: the sender is called with the Markdown untouched, the plain-text fallback on an API error, splitting past the limit, and that message ids are recorded.

## Outcome

Built as described in docs/design.md §4 ("Telegram formatting") and decision #69.
- **Sending:** replies go out via `sendRichMessage` with the model's Markdown, falling back to plain text on any error.
- **Converter removed:** the Markdown-to-HTML converter and the `marked` dependency are deleted. Only plain splitting past 32,768 characters remains (`telegram/split.ts`).
- **The HTML question:** a live test showed Rich Markdown renders **images** (Markdown and `<img>`) as well as HTML. That means a zero-click exfiltration channel, so `sanitizeRichMarkdown` turns images into links and escapes anything that could start a tag, everywhere and without a parser (so it can't disagree with Telegram's). The cosmetic cost: tags inside code snippets show escaped.
- **Rendering check:** confirmed by the user on phone and desktop.
- **Prompt:** Markdown is welcome, including lists and small tables. No headings in ordinary replies, and no HTML.
