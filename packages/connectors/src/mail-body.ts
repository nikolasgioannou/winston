/**
 * Mail bodies as Winston reads them (docs/design.md §5, Gmail (read)): plain
 * text when there is some, else the HTML as text, with quoted earlier
 * messages left out where they're reliably marked. Shared by every mail
 * provider, so a message reads the same wherever it came from.
 */
import { compile } from "html-to-text";

const htmlToText = compile({
  wordwrap: false,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    // Quoted earlier messages, as each client marks them.
    { selector: "div.gmail_quote", format: "skip" },
    { selector: "blockquote[type=cite]", format: "skip" },
    { selector: "div.yahoo_quoted", format: "skip" },
  ],
});

const quoteMarkers =
  /class=["'][^"']*\b(gmail_quote|yahoo_quoted)\b|<blockquote[^>]*type=["']?cite/i;

/**
 * Hides a plain-text reply's quoted tail: from an "On … wrote:" line (which
 * mail clients sometimes wrap over two lines) when `>` lines follow it.
 */
export function stripQuotedText(text: string): {
  text: string;
  hidden: boolean;
} {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const joined = `${line} ${lines[i + 1] ?? ""}`;
    const intro = /^On .+wrote:\s*$/.test(line)
      ? 1
      : /^On .+wrote:\s*$/.test(joined)
        ? 2
        : 0;
    if (!intro) continue;
    const rest = lines.slice(i + intro).filter((l) => l.trim() !== "");
    if (rest.length > 0 && rest.every((l) => l.startsWith(">")))
      return { text: lines.slice(0, i).join("\n").trimEnd(), hidden: true };
  }
  return { text, hidden: false };
}

/** The readable body: plain text if there is some, else the HTML as text. */
export function readableBody(
  plain: string | undefined,
  html: string | undefined,
): { body: string; quotedTextHidden: boolean } {
  if (plain !== undefined) {
    const { text, hidden } = stripQuotedText(plain);
    return { body: text.trim(), quotedTextHidden: hidden };
  }
  if (html === undefined) return { body: "", quotedTextHidden: false };
  return {
    body: htmlToText(html).trim(),
    quotedTextHidden: quoteMarkers.test(html),
  };
}
