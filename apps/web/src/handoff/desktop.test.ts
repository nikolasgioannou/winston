import { describe, expect, test } from "bun:test";
import { keysymsFor } from "./desktop";

describe("typing on the full desktop", () => {
  test("named keys, Latin-1 and other text become X keysyms", () => {
    expect(keysymsFor({ kind: "key", key: "Enter" })).toEqual([0xff0d]);
    expect(keysymsFor({ kind: "key", key: "Backspace" })).toEqual([0xff08]);
    expect(keysymsFor({ kind: "text", text: "aé€" })).toEqual([
      0x61, 0xe9, 0x10020ac,
    ]);
    expect(
      keysymsFor({ kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 1 }),
    ).toEqual([]);
  });
});
