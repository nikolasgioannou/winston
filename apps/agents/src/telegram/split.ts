/** Telegram's limit for one Rich Message. */
export const richMessageLimit = 32_768;

/**
 * Splits text into parts within the limit at the first separator that works
 * (paragraphs, then lines, then spaces), then cuts hard, never inside a
 * surrogate pair (an emoji).
 */
export function splitText(text: string, limit: number) {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const separator of ["\n\n", "\n", " "]) {
      cut = window.lastIndexOf(separator);
      if (cut > 0) break;
    }
    if (cut <= 0) {
      const code = rest.charCodeAt(limit - 1);
      cut = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
    }
    const part = rest.slice(0, cut).trimEnd();
    if (part) parts.push(part);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
