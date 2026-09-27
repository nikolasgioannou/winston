/**
 * Makes model-written Markdown safe to send as a Rich Message, which renders
 * images and inline HTML. A rendered image means its URL gets fetched, so a
 * prompt-injected reply could leak data through the URL without a click.
 *
 * - Images become ordinary links (`![alt](url)` → `[alt](url)`).
 * - Anything that could start an HTML tag becomes text (`<b` → `&lt;b`).
 *
 * Applied everywhere, deliberately without a Markdown parser: a parser that
 * disagreed with Telegram's in an edge case could skip an image Telegram
 * then renders. The cost is cosmetic and rare: a tag inside a code snippet
 * shows as `&lt;tag>`.
 */
export function sanitizeRichMarkdown(markdown: string) {
  return markdown.replaceAll("![", "[").replace(/<(?=[A-Za-z/!?])/g, "&lt;");
}
