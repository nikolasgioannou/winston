import { describe, expect, test } from "bun:test";
import { formatForTelegram, splitPlain, visibleText } from "./format.ts";

/** A short message's single HTML part. */
const html = (markdown: string) => {
  const parts = formatForTelegram(markdown);
  expect(parts).toHaveLength(1);
  return parts[0] ?? "";
};

describe("formatForTelegram: the subset", () => {
  test("bold, italic, strikethrough and inline code", () => {
    expect(
      html("**Your 3pm** moved, _not_ ~~cancelled~~. Run `npm test`."),
    ).toBe(
      "<b>Your 3pm</b> moved, <i>not</i> <s>cancelled</s>. Run <code>npm test</code>.",
    );
  });

  test("nested formatting", () => {
    expect(html("**bold _and italic_**")).toBe("<b>bold <i>and italic</i></b>");
  });

  test("links, including bare URLs; unsafe schemes become plain text", () => {
    expect(html("[the doc](https://example.com/a?b=1&c=2)")).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2">the doc</a>',
    );
    expect(html("see https://example.com")).toBe(
      'see <a href="https://example.com">https://example.com</a>',
    );
    expect(html("[click](javascript:alert(1))")).toBe("click");
  });

  test("code blocks keep their language; a safe-looking language only", () => {
    expect(html("```ts\nconst a = 1 < 2;\n```")).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
    );
    expect(html('```x" onclick="\ncode\n```')).toBe("<pre>code</pre>");
  });

  test("lists become lines, with nesting, numbering and formatting inside items", () => {
    expect(html("- **Dana** at 3\n- Ana at 4\n  - bring notes")).toBe(
      "• <b>Dana</b> at 3\n• Ana at 4\n   • bring notes",
    );
    expect(html("3. third\n4. fourth")).toBe("3. third\n4. fourth");
  });

  test("headings become bold lines, and blockquotes stay (unnested)", () => {
    expect(html("# Today\n\nNothing urgent.")).toBe(
      "<b>Today</b>\n\nNothing urgent.",
    );
    expect(html("> quoted\n>\n> > deeper")).toBe(
      "<blockquote>quoted\ndeeper</blockquote>",
    );
  });
});

describe("formatForTelegram: escaping and degrading", () => {
  test("escapes <, > and & everywhere", () => {
    expect(html("Tom & Jerry <3 **a<b>**")).toBe(
      "Tom &amp; Jerry &lt;3 <b>a&lt;b&gt;</b>",
    );
  });

  test("raw HTML is shown as written, never passed through", () => {
    expect(html("hi <br> there <script>x</script>")).toBe(
      "hi &lt;br&gt; there &lt;script&gt;x&lt;/script&gt;",
    );
  });

  test("tables degrade to their text", () => {
    const out = html("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(out).not.toContain("<table");
    expect(visibleText(out)).toContain("| 1 | 2 |");
  });

  test("code inside bold or a link becomes plain text, which Telegram requires", () => {
    expect(html("**run `this`**")).toBe("<b>run this</b>");
    expect(html("[`cmd`](https://example.com)")).toBe(
      '<a href="https://example.com">cmd</a>',
    );
  });
});

describe("formatForTelegram: splitting", () => {
  const limit = 4096;
  const paragraph = "The quick brown fox jumps over the lazy dog. "
    .repeat(30)
    .trim();

  test("packs whole blocks into messages within the limit", () => {
    const markdown = Array.from(
      { length: 8 },
      (_, i) => `**${String(i)}** ${paragraph}`,
    ).join("\n\n");
    const parts = formatForTelegram(markdown);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(visibleText(part).length).toBeLessThanOrEqual(limit);
      // Tags are balanced in every part.
      expect(part.match(/<b>/g)?.length).toBe(part.match(/<\/b>/g)?.length);
    }
    expect(parts.join("\n\n")).toContain("<b>7</b>");
  });

  test("counts visible characters, not tags", () => {
    // 4000 visible characters of bold: fits, though the HTML is longer.
    expect(formatForTelegram(`**${"a".repeat(4000)}**`)).toHaveLength(1);
  });

  test("a very long code block becomes several code blocks, split at lines", () => {
    const code = Array.from(
      { length: 400 },
      (_, i) => `line ${String(i)} ${"x".repeat(20)}`,
    ).join("\n");
    const parts = formatForTelegram(`\`\`\`py\n${code}\n\`\`\``);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.startsWith('<pre><code class="language-py">')).toBe(true);
      expect(part.endsWith("</code></pre>")).toBe(true);
      expect(visibleText(part).length).toBeLessThanOrEqual(limit);
    }
    expect(parts.map(visibleText).join("\n")).toBe(code);
  });

  test("a single paragraph too long for one message is split as plain text", () => {
    const words = "word ".repeat(1500).trim();
    const parts = formatForTelegram(`**${words}**`);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts)
      expect(visibleText(part).length).toBeLessThanOrEqual(limit);
  });
});

describe("splitPlain", () => {
  test("prefers paragraphs, then lines, then spaces, then a hard cut", () => {
    expect(splitPlain("First paragraph.\n\nSecond.", 20)).toEqual([
      "First paragraph.",
      "Second.",
    ]);
    expect(splitPlain("line one is long\nline two", 20)).toEqual([
      "line one is long",
      "line two",
    ]);
    expect(splitPlain("one two three four five", 10)).toEqual([
      "one two",
      "three four",
      "five",
    ]);
    expect(splitPlain("a".repeat(25), 10)).toEqual([
      "a".repeat(10),
      "a".repeat(10),
      "a".repeat(5),
    ]);
  });

  test("never splits an emoji near the boundary", () => {
    // Each 😀 is two UTF-16 code units; a cut at 9 would land between them.
    expect(splitPlain("aaaaaaaa😀😀😀", 9)).toEqual(["aaaaaaaa", "😀😀😀"]);
  });
});
