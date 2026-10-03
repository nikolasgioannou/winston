# Research: Telegram formatting and Rich Messages

> Researched 2026-09-27 against Bot API 10.3 (2026-08-24), plus a live test from @RunWinstonDevBot.

## The classic formatting modes

`sendMessage` takes a `parse_mode` or an explicit `entities` array:

- **`MarkdownV2`** is Telegram's own dialect, not standard Markdown. For example, `*bold*` uses single asterisks. Every `_ * [ ] ( ) ~ ` > # + - = | { } . !` outside an entity must be backslash-escaped, and one stray character rejects the whole message ("can't parse entities: Character '.' is reserved"). It has no lists or headings. LLM output breaks it constantly, as many issues in other bots confirm.
- **`Markdown`** is "a legacy mode, retained for backward compatibility": no nesting and minimal escaping.
- **`HTML`** needs only `< > &` escaped and supports b/i/u/s, spoilers, links, code/pre and blockquote. It has no lists, headings or `<br>`, and one unsupported tag rejects the message. This is what Winston uses today, converting the model's Markdown with `marked` (`apps/agents/src/telegram/format.ts`).
- **`entities`:** plain text plus `MessageEntity` offsets in UTF-16 code units, with no escaping at all. Converters exist, for example `telegramify-markdown` (Python 1.4.0 returns text plus entities; the npm 1.3.3 package targets MarkdownV2).

The limit is 4,096 characters after entities are parsed.

## Rich Messages (Bot API 10.1, June 2026)

- `sendRichMessage` takes `rich_message: InputRichMessage` with exactly one of `markdown`, `html` or `blocks`. `editMessageText` accepts `rich_message` too.
- Telegram describes it as "compatible with GitHub Flavored Markdown where possible and can contain arbitrary HTML":
  - `**bold**`, `*italic*`/`_italic_`, `~~strike~~`
  - code and fenced code with a language
  - `#`–`######` headings, `-`/`*`/`+` and `1.` lists, task lists
  - `>` quotes, `---`, GFM tables, footnotes, `$math$`, `||spoiler||`, `==mark==`
  - HTML such as `<u>` and `<details>`
- Limits: 32,768 characters, 500 blocks, 16 nesting levels, 20 table columns.
- **`sendRichMessageDraft`** streams a partial message in private chats. It's an ephemeral preview for about 30 seconds, finalized by `sendRichMessage`.
- Library support: grammY 1.46.0 and python-telegram-bot 22.8 don't type these methods yet, so call them through the raw API.

## Live test (2026-09-27)

Three rich messages from the dev bot to the maintainer's chat, via `sendRichMessage` with `markdown`:

1. **An everyday reply** (bold, a link, a bullet list, italics, inline code) rendered natively, with real list bullets.
2. **Headings, a table, a code block, a quote, numbered and task lists, a divider, strikethrough and a spoiler** all rendered. Headings render large (serif), too heavy for an ordinary chat reply.
3. **Deliberately malformed Markdown** was **accepted** (HTTP 200) and degraded to literal text. A stray `<b>` was rendered as HTML and bolded the rest of the line.

Checked on desktop. A second test (same day) confirmed the same rendering on the phone apps, and showed that **images render**: both a Markdown image and an HTML `<img>` displayed as real pictures. So a URL in model output can get fetched with no click, which is a data-exfiltration channel for prompt injection. Winston therefore neutralizes images and HTML before sending (docs/design.md §4).

## Implications for Winston

- Rich Messages can replace the Markdown-to-HTML converter: send the model's Markdown as-is, with a plain-text fallback on errors, splitting only past 32,768 characters. Tables and real lists become available.
- The prompt should still avoid headings in ordinary replies. Images and inline HTML both render, so model output must have them neutralized before sending.
- Drafts make streaming possible, which the design currently rules out (§4, decision #14). That needs its own decision.

## Drafts in detail (checked 2026-10-02, Bot API 10.3)

- `sendRichMessageDraft(chat_id, draft_id, rich_message, can_stop?, keep_on_stop?)` and its plain twin `sendMessageDraft(chat_id, draft_id, text?, …)`; private chats only; both return `True`.
- `draft_id` is any non-zero integer: updates with the same id animate in place; a new id replaces the draft without animation.
- The draft is a temporary ~30-second preview. It disappears when the bot sends a message, so the real message (`sendRichMessage`) is what persists. An abandoned draft just fades out.
- `sendMessageDraft` with empty text shows a "Thinking…" placeholder.
- 10.3 added `can_stop` (a stop button; the bot gets a `stopped_message_generation` update) and `keep_on_stop` (the partial draft stays briefly after a stop).
- No rate limit is documented for draft updates.
- **Decision:** not adopted for streaming replies (docs/design.md decision #72): refused outputs must never be shown, and some are cut mid-stream; most replies are short.
- **Used for statuses (feebd3, decision #75):** a front-of-house step's interim text, whole and from a step that ended normally, is shown with `sendRichMessageDraft` under one `draft_id` per turn, and the turn's messages replace it. Not yet checked on a phone: how the 30-second fade looks during a long browser step, and whether re-sending to keep it alive is worth it.
