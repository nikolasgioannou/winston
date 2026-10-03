import { describe, expect, test } from "bun:test";
import { parseTimeFlag, TimeParseError, type Direction } from "./time-flag.ts";

// Friday 6 March 2026, 10:00 in New York (15:00 in London). New York's clocks
// spring forward on Sunday 8 March; London's on Sunday 29 March.
const now = new Date("2026-03-06T15:00:00Z");
const ny = "America/New_York";
const london = "Europe/London";

const at = (input: string, timeZone: string, direction: Direction = "future") =>
  parseTimeFlag(input, { timeZone, direction, now }).toISOString();

describe("parseTimeFlag", () => {
  test.each([
    // input, zone, direction, expected instant
    ["now", ny, "past", "2026-03-06T15:00:00.000Z"],
    ["2h", ny, "past", "2026-03-06T13:00:00.000Z"],
    ["2h", ny, "future", "2026-03-06T17:00:00.000Z"],
    ["30 min", ny, "future", "2026-03-06T15:30:00.000Z"],
    // 3 calendar days ahead crosses the change: 10:00 EST Friday is 10:00 EDT Monday.
    ["3d", ny, "future", "2026-03-09T14:00:00.000Z"],
    ["1w", ny, "past", "2026-02-27T15:00:00.000Z"],
    // Four weeks ahead crosses London's change: 15:00 GMT becomes 15:00 BST.
    ["4w", london, "future", "2026-04-03T14:00:00.000Z"],
    // A date is the start of that day in the user's zone.
    ["2026-09-28", ny, "future", "2026-09-28T04:00:00.000Z"],
    ["2026-09-28T09:00", ny, "future", "2026-09-28T13:00:00.000Z"],
    ["2026-09-28T09:00", london, "future", "2026-09-28T08:00:00.000Z"],
    // An offset (or Z) is that exact moment, whoever's zone it is.
    ["2026-10-08T17:40+03:00", ny, "future", "2026-10-08T14:40:00.000Z"],
    ["2026-09-28T09:00:00Z", ny, "future", "2026-09-28T09:00:00.000Z"],
    ["2026-11-01T01:30-04:00", ny, "future", "2026-11-01T05:30:00.000Z"],
    ["  2026-09-28T09:00 ", ny, "future", "2026-09-28T13:00:00.000Z"],
  ] as const)("%s in %s (%s) → %s", (input, zone, direction, expected) => {
    expect(at(input, zone, direction)).toBe(expected);
  });

  test.each([
    // A time the clocks skip, and one they repeat, without an offset.
    ["2026-03-08T02:30", "clocks change"],
    ["2026-11-01T01:30", "clocks change"],
    // Phrases are gone: an exact time says what was meant.
    ["tomorrow 9am", "Couldn't understand"],
    ["tonight 9:40pm", "Couldn't understand"],
    ["fri", "Couldn't understand"],
    ["today", "Couldn't understand"],
    ["9am", "Couldn't understand"],
    ["in 2h", "Couldn't understand"],
    ["2h ago", "Couldn't understand"],
    ["25:00", "Couldn't understand"],
    ["2026-02-30", "Couldn't understand"],
    ["2026-09-28T25:00", "Couldn't understand"],
    ["", "Couldn't understand"],
    ["3 fortnights", "Couldn't understand"],
  ])("rejects %j, showing the accepted forms", (input, message) => {
    const error = (() => {
      try {
        at(input, ny);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(TimeParseError);
    expect(String(error)).toContain(message);
    expect((error as TimeParseError).hint).toContain("2026-10-08T17:40+03:00");
  });
});
