/**
 * Converts the Markdown subset agents write into Telegram HTML messages
 * (docs/design.md §4, "Telegram formatting"). Telegram's HTML supports only
 * b/i/u/s, spoilers, links, code/pre and blockquote: no lists, headings or
 * `<br>`, and any unsupported tag fails the whole message. So everything is
 * escaped, lists and headings become plain lines, and anything outside the
 * subset degrades to escaped text instead of breaking.
 */
import { marked, type Token, type Tokens } from "marked";

/** Telegram's limit for one message: visible characters after parsing, in UTF-16 code units. */
export const telegramMessageLimit = 4096;

export function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const escapeAttribute = (text: string) =>
  escapeHtml(text).replaceAll('"', "&quot;");

/** What Telegram shows for our HTML: tags removed, our entities decoded. */
export function visibleText(html: string) {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

const safeLink = /^(https?:|mailto:)/i;
const codeLanguage = /^[\w+#.-]+$/;

/**
 * Inline formatting. Telegram forbids code inside bold, italic, strikethrough
 * or links, so inside those `inFormatting` renders code as plain text.
 */
function inline(tokens: readonly Token[], inFormatting = false): string {
  return tokens.map((token) => inlineToken(token, inFormatting)).join("");
}

function inlineToken(token: Token, inFormatting: boolean): string {
  switch (token.type) {
    case "strong":
      return `<b>${inline((token as Tokens.Strong).tokens, true)}</b>`;
    case "em":
      return `<i>${inline((token as Tokens.Em).tokens, true)}</i>`;
    case "del":
      return `<s>${inline((token as Tokens.Del).tokens, true)}</s>`;
    case "codespan": {
      const text = escapeHtml((token as Tokens.Codespan).text);
      return inFormatting ? text : `<code>${text}</code>`;
    }
    case "link":
    case "image": {
      const link = token as Tokens.Link | Tokens.Image;
      const label = link.tokens.length
        ? inline(link.tokens, true)
        : escapeHtml(link.text || link.href);
      return safeLink.test(link.href)
        ? `<a href="${escapeAttribute(link.href)}">${label || escapeHtml(link.href)}</a>`
        : label;
    }
    case "br":
      return "\n";
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens
        ? inline(text.tokens, inFormatting)
        : escapeHtml(text.text);
    }
    default:
      // escape, inline html and anything unforeseen: shown as written.
      return escapeHtml("text" in token ? String(token.text) : token.raw);
  }
}

/** One top-level block as Telegram HTML, or undefined for blank space. */
function block(token: Token, inQuote = false): string | undefined {
  switch (token.type) {
    case "space":
      return undefined;
    case "paragraph":
      return inline((token as Tokens.Paragraph).tokens);
    case "heading":
      return `<b>${inline((token as Tokens.Heading).tokens, true)}</b>`;
    case "code":
      return codeBlock(token as Tokens.Code);
    case "list":
      return list(token as Tokens.List, "");
    case "blockquote": {
      const inner = (token as Tokens.Blockquote).tokens
        .map((child) => block(child, true))
        .filter((html) => html !== undefined)
        .join("\n");
      // Blockquotes can't nest in Telegram; an inner one is just its content.
      return inQuote ? inner : `<blockquote>${inner}</blockquote>`;
    }
    case "hr":
      return "———";
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens ? inline(text.tokens) : escapeHtml(text.text);
    }
    default:
      // Tables, raw HTML and anything else outside the subset: as written.
      return escapeHtml(token.raw.trim());
  }
}

function codeBlock(code: Tokens.Code) {
  const body = escapeHtml(code.text);
  const lang = code.lang?.trim() ?? "";
  return codeLanguage.test(lang)
    ? `<pre><code class="language-${lang}">${body}</code></pre>`
    : `<pre>${body}</pre>`;
}

function list(token: Tokens.List, indent: string): string {
  const start = typeof token.start === "number" ? token.start : 1;
  return token.items
    .map((item, index) => {
      const marker = token.ordered ? `${String(start + index)}. ` : "• ";
      const lines: string[] = [];
      for (const child of item.tokens) {
        if (child.type === "list")
          lines.push(list(child as Tokens.List, `${indent}   `));
        else {
          const html = block(child);
          if (html !== undefined) lines.push(html);
        }
      }
      const [first = "", ...rest] = lines;
      return [`${indent}${marker}${first}`, ...rest].join("\n");
    })
    .join("\n");
}

/**
 * Renders Markdown into Telegram HTML messages, each within the limit.
 * Whole blocks are packed into messages; a block too long on its own is
 * split (a code block into several code blocks, anything else as plain
 * text), so a split never lands inside a tag.
 */
export function formatForTelegram(
  markdown: string,
  limit = telegramMessageLimit,
) {
  const blocks = marked.lexer(markdown).flatMap((token) => {
    const html = block(token);
    if (html === undefined || !visibleText(html).trim()) return [];
    if (visibleText(html).length <= limit) return [html];
    return token.type === "code"
      ? splitCode(token as Tokens.Code, limit)
      : splitPlain(visibleText(html), limit).map(escapeHtml);
  });

  const messages: string[] = [];
  let current = "";
  for (const html of blocks) {
    const joined = current ? `${current}\n\n${html}` : html;
    if (visibleText(joined).length <= limit) current = joined;
    else {
      messages.push(current);
      current = html;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function splitCode(code: Tokens.Code, limit: number) {
  const wrap = (text: string) => codeBlock({ ...code, text });
  const parts: string[] = [];
  let current = "";
  for (const line of splitPlain(code.text, limit, ["\n"], false)) {
    const joined = current ? `${current}\n${line}` : line;
    if (current && joined.length > limit) {
      parts.push(wrap(current));
      current = line;
    } else current = joined;
  }
  if (current) parts.push(wrap(current));
  return parts;
}

/**
 * Splits plain text into parts within the limit at the first separator that
 * works, then cuts hard, never inside a surrogate pair (an emoji).
 */
export function splitPlain(
  text: string,
  limit: number,
  separators = ["\n\n", "\n", " "],
  trim = true,
) {
  const parts: string[] = [];
  let rest = trim ? text.trim() : text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const separator of separators) {
      cut = window.lastIndexOf(separator);
      if (cut > 0) break;
    }
    if (cut <= 0) {
      const code = rest.charCodeAt(limit - 1);
      cut = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
    }
    const part = trim ? rest.slice(0, cut).trimEnd() : rest.slice(0, cut);
    if (part) parts.push(part);
    rest = rest.slice(cut);
    rest = trim ? rest.trimStart() : rest.replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}
