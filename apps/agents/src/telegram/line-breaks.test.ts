import { describe, expect, test } from "bun:test";
import { keepLineBreaks } from "./line-breaks.ts";

describe("keepLineBreaks", () => {
  test("lines written one after another stay separate lines", () => {
    expect(
      keepLineBreaks(
        "Autumn dinner steam\nSister's name drifts\nQuiet evening waits",
      ),
    ).toBe(
      "Autumn dinner steam  \nSister's name drifts  \nQuiet evening waits",
    );
  });

  test("paragraph breaks, list items and existing hard breaks are left alone", () => {
    expect(keepLineBreaks("First.\n\nSecond.")).toBe("First.\n\nSecond.");
    const alreadyBroken = "already  \nbroken\\\nhere";
    expect(keepLineBreaks(alreadyBroken)).toBe(alreadyBroken);
  });

  test("fenced code is untouched", () => {
    const text = "Run this:\n```sh\nls -la\ncd ~\n```\nThen that.";
    expect(keepLineBreaks(text)).toBe(
      "Run this:  \n```sh\nls -la\ncd ~\n```\nThen that.",
    );
  });
});
