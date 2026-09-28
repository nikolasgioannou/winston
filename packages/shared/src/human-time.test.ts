import { describe, expect, test } from "bun:test";
import {
  parseHumanTime,
  TimeParseError,
  type Direction,
} from "./human-time.ts";

// Friday 6 March 2026, 10:00 in New York (15:00 in London). New York's clocks
// spring forward on Sunday 8 March; London's on Sunday 29 March.
const now = new Date("2026-03-06T15:00:00Z");
const ny = "America/New_York";
const london = "Europe/London";

const at = (input: string, timeZone: string, direction: Direction = "future") =>
  parseHumanTime(input, { timeZone, direction, now }).toISOString();

describe("parseHumanTime", () => {
  test.each([
    // input, zone, direction, expected instant
    ["now", ny, "past", "2026-03-06T15:00:00.000Z"],
    ["2h", ny, "past", "2026-03-06T13:00:00.000Z"],
    ["2h", ny, "future", "2026-03-06T17:00:00.000Z"],
    ["in 30m", ny, "past", "2026-03-06T15:30:00.000Z"],
    ["2h ago", ny, "future", "2026-03-06T13:00:00.000Z"],
    // 3 calendar days ahead crosses the change: 10:00 EST Friday is 10:00 EDT Monday.
    ["3d", ny, "future", "2026-03-09T14:00:00.000Z"],
    ["1w", ny, "past", "2026-02-27T15:00:00.000Z"],
    ["today", ny, "past", "2026-03-06T05:00:00.000Z"],
    ["tomorrow 9am", ny, "future", "2026-03-07T14:00:00.000Z"],
    ["9am tomorrow", ny, "future", "2026-03-07T14:00:00.000Z"],
    ["yesterday at noon", ny, "past", "2026-03-05T17:00:00.000Z"],
    ["noon", ny, "future", "2026-03-06T17:00:00.000Z"],
    ["15:30", ny, "future", "2026-03-06T20:30:00.000Z"],
    // Monday 9 March is after the change: 9am EDT.
    ["mon 9am", ny, "future", "2026-03-09T13:00:00.000Z"],
    // A weekday never means today: on a Friday, "fri" is next week's.
    ["fri", ny, "future", "2026-03-13T04:00:00.000Z"],
    ["friday", ny, "past", "2026-02-27T05:00:00.000Z"],
    ["last friday", ny, "future", "2026-02-27T05:00:00.000Z"],
    ["next monday 9:30pm", ny, "past", "2026-03-10T01:30:00.000Z"],
    ["2026-09-28", ny, "future", "2026-09-28T04:00:00.000Z"],
    ["2026-09-28T09:00", ny, "future", "2026-09-28T13:00:00.000Z"],
    ["2026-09-28T09:00:00Z", ny, "future", "2026-09-28T09:00:00.000Z"],
    ["2026-11-01T01:30-04:00", ny, "future", "2026-11-01T05:30:00.000Z"],
    ["tomorrow 9am", london, "future", "2026-03-07T09:00:00.000Z"],
    // Four weeks ahead crosses London's change: 15:00 GMT becomes 15:00 BST.
    ["in 4w", london, "past", "2026-04-03T14:00:00.000Z"],
    ["  Tomorrow   9AM ", london, "future", "2026-03-07T09:00:00.000Z"],
  ] as const)("%s in %s (%s) → %s", (input, zone, direction, expected) => {
    expect(at(input, zone, direction)).toBe(expected);
  });

  test.each([
    // A time the clocks skip, and one they repeat, without an offset.
    ["2026-03-08T02:30", "clocks change"],
    ["2026-11-01T01:30", "clocks change"],
    ["9", "Couldn't understand"],
    ["25:00", "Couldn't understand"],
    ["13pm", "Couldn't understand"],
    ["in 2h ago", "Couldn't understand"],
    ["next week sometime", "Couldn't understand"],
    ["friday 3", "Couldn't understand"],
    ["2026-02-30", "Couldn't understand"],
    ["", "Couldn't understand"],
    ["3 fortnights", "Couldn't understand"],
  ])("rejects %j", (input, message) => {
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
    expect((error as TimeParseError).hint).toContain("ISO-8601");
  });
});
