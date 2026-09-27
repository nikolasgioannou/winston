import { describe, expect, test } from "bun:test";
import { splitText } from "./split.ts";

describe("splitText", () => {
  test("leaves text within the limit alone", () => {
    expect(splitText("Your 3pm moved to 4.", 20)).toEqual([
      "Your 3pm moved to 4.",
    ]);
  });

  test("prefers paragraphs, then lines, then spaces, then a hard cut", () => {
    expect(splitText("First paragraph.\n\nSecond.", 20)).toEqual([
      "First paragraph.",
      "Second.",
    ]);
    expect(splitText("line one is long\nline two", 20)).toEqual([
      "line one is long",
      "line two",
    ]);
    expect(splitText("one two three four five", 10)).toEqual([
      "one two",
      "three four",
      "five",
    ]);
    expect(splitText("a".repeat(25), 10)).toEqual([
      "a".repeat(10),
      "a".repeat(10),
      "a".repeat(5),
    ]);
  });

  test("never splits an emoji near the boundary", () => {
    // Each 😀 is two UTF-16 code units; a cut at 9 would land between them.
    expect(splitText("aaaaaaaa😀😀😀", 9)).toEqual(["aaaaaaaa", "😀😀😀"]);
  });
});
