import { describe, expect, test } from "bun:test";
import type { ViewerInput } from "@winston/domain/frames";
import { createGestures, textChange, toTab } from "./input";

// The canvas shows a 1280×800 tab at 390×244 on screen, 100px down the page.
const canvas = { left: 0, top: 100, width: 390, height: 243.75 };
const frame = { width: 1280, height: 800 };

describe("the live view's input", () => {
  test("a point on the canvas is the same point in the tab, whatever the scale", () => {
    expect(toTab({ x: 195, y: 100 + 121.875 }, canvas, frame)).toEqual({
      x: 640,
      y: 400,
    });
    // Edges stay inside the tab.
    expect(toTab({ x: -5, y: 9999 }, canvas, frame)).toEqual({ x: 0, y: 799 });
  });

  test("a tap clicks where the finger landed; a drag scrolls with the finger and clicks nothing", () => {
    const sent: ViewerInput[] = [];
    const gestures = createGestures(
      (input) => sent.push(input),
      () => ({ canvas, frame }),
    );
    gestures.down({ x: 195, y: 160 }, "touch");
    gestures.move({ x: 198, y: 162 }, "touch");
    gestures.up({ x: 198, y: 162 }, "touch");
    expect(
      sent.map((s) => [s.kind, "action" in s ? s.action : undefined]),
    ).toEqual([
      ["pointer", "down"],
      ["pointer", "up"],
    ]);
    expect(sent[0]).toMatchObject({ x: 640, y: 197 });

    sent.length = 0;
    gestures.down({ x: 195, y: 300 }, "touch");
    gestures.move({ x: 195, y: 260 }, "touch");
    gestures.up({ x: 195, y: 260 }, "touch");
    expect(sent).toHaveLength(1);
    // 40px up on screen is 131px down in the tab: the page follows the finger.
    expect(sent[0]).toMatchObject({ kind: "wheel", deltaX: 0, deltaY: 131 });
  });

  test("a mouse presses, drags and releases as itself", () => {
    const sent: ViewerInput[] = [];
    const gestures = createGestures(
      (input) => sent.push(input),
      () => ({ canvas, frame }),
    );
    gestures.down({ x: 10, y: 110 }, "mouse");
    gestures.move({ x: 20, y: 110 }, "mouse");
    gestures.up({ x: 20, y: 110 }, "mouse");
    expect(sent.map((s) => ("action" in s ? s.action : s.kind))).toEqual([
      "down",
      "move",
      "up",
    ]);
  });

  test("the phone keyboard's typing, autocorrect and deleting become text and backspaces", () => {
    expect(textChange("", "4")).toEqual([{ kind: "text", text: "4" }]);
    // Autocorrect replacing a word: only what changed is retyped.
    expect(textChange("teh", "the")).toEqual([
      { kind: "key", key: "Backspace" },
      { kind: "key", key: "Backspace" },
      { kind: "text", text: "he" },
    ]);
    expect(textChange("ab", "a")).toEqual([{ kind: "key", key: "Backspace" }]);
    expect(textChange("", "pasted code 123")).toEqual([
      { kind: "text", text: "pasted code 123" },
    ]);
    expect(textChange("👍", "👍!")).toEqual([{ kind: "text", text: "!" }]);
  });
});
