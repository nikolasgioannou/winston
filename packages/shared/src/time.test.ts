import { describe, expect, test } from "bun:test";
import { formatInTimeZone } from "./time.ts";

const instant = new Date("2026-09-26T21:03:12.789Z");

describe("formatInTimeZone", () => {
  test("renders local time with the zone's offset", () => {
    expect(formatInTimeZone(instant, "America/Los_Angeles")).toBe(
      "2026-09-26T14:03:12-07:00",
    );
    expect(formatInTimeZone(instant, "Asia/Kolkata")).toBe(
      "2026-09-27T02:33:12+05:30",
    );
    expect(formatInTimeZone(instant, "UTC")).toBe("2026-09-26T21:03:12+00:00");
  });

  test("follows daylight saving time", () => {
    expect(
      formatInTimeZone(new Date("2026-01-15T17:00:00Z"), "America/New_York"),
    ).toBe("2026-01-15T12:00:00-05:00");
    expect(
      formatInTimeZone(new Date("2026-07-15T16:00:00Z"), "America/New_York"),
    ).toBe("2026-07-15T12:00:00-04:00");
  });

  test("renders midnight as 00, not 24", () => {
    expect(
      formatInTimeZone(new Date("2026-09-27T04:00:00Z"), "America/New_York"),
    ).toBe("2026-09-27T00:00:00-04:00");
  });

  test("rejects an unknown time zone", () => {
    expect(() => formatInTimeZone(instant, "Mars/Olympus")).toThrow(RangeError);
  });
});
