import { describe, expect, test } from "bun:test";
import { freeSlots, mergeIntervals } from "./free-slots.ts";

const ny = "America/New_York";
const d = (iso: string) => new Date(iso);
const show = (slots: { start: Date; end: Date }[]) =>
  slots.map((s) => `${s.start.toISOString()}–${s.end.toISOString()}`);

describe("free slots", () => {
  test("overlapping and touching busy blocks merge", () => {
    expect(
      mergeIntervals([
        { start: d("2026-09-29T15:00:00Z"), end: d("2026-09-29T16:00:00Z") },
        { start: d("2026-09-29T14:00:00Z"), end: d("2026-09-29T15:30:00Z") },
        { start: d("2026-09-29T16:00:00Z"), end: d("2026-09-29T16:30:00Z") },
        { start: d("2026-09-29T18:00:00Z"), end: d("2026-09-29T18:00:00Z") },
      ]),
    ).toEqual([
      { start: d("2026-09-29T14:00:00Z"), end: d("2026-09-29T16:30:00Z") },
    ]);
  });

  test("gaps inside 9–18 in the user's zone, long enough for the meeting", () => {
    const slots = freeSlots({
      // Tuesday, Sep 29 2026 (EDT, UTC−4): busy 10–11 and 11:15–15:00 local.
      busy: [
        { start: d("2026-09-29T14:00:00Z"), end: d("2026-09-29T15:00:00Z") },
        { start: d("2026-09-29T15:15:00Z"), end: d("2026-09-29T19:00:00Z") },
      ],
      since: d("2026-09-29T04:00:00Z"),
      until: d("2026-09-30T04:00:00Z"),
      durationMinutes: 30,
      timeZone: ny,
    });
    // 9–10 and 15–18 local; the 15-minute gap is too short.
    expect(show(slots)).toEqual([
      "2026-09-29T13:00:00.000Z–2026-09-29T14:00:00.000Z",
      "2026-09-29T19:00:00.000Z–2026-09-29T22:00:00.000Z",
    ]);
  });

  test("weekends are skipped unless included; 'since' later than 9:00 starts there", () => {
    const base = {
      busy: [],
      since: d("2026-10-02T18:30:00Z"), // Friday 14:30 local
      until: d("2026-10-06T04:00:00Z"), // Monday night
      durationMinutes: 60,
      timeZone: ny,
    };
    expect(show(freeSlots(base))).toEqual([
      "2026-10-02T18:30:00.000Z–2026-10-02T22:00:00.000Z",
      "2026-10-05T13:00:00.000Z–2026-10-05T22:00:00.000Z",
    ]);
    const withWeekends = freeSlots({
      ...base,
      hours: {
        startMinute: 10 * 60,
        endMinute: 12 * 60,
        days: [1, 2, 3, 4, 5, 6, 7],
      },
    });
    expect(withWeekends).toHaveLength(3);
  });

  test("on the day the clocks fall back, 9–18 local is still 9–18 local", () => {
    // Sunday Nov 1 2026: EDT → EST at 2:00. 9:00 EST is 14:00Z.
    const slots = freeSlots({
      busy: [],
      since: d("2026-11-01T04:00:00Z"),
      until: d("2026-11-02T05:00:00Z"),
      durationMinutes: 30,
      timeZone: ny,
      hours: { startMinute: 9 * 60, endMinute: 18 * 60, days: [7] },
    });
    expect(show(slots)).toEqual([
      "2026-11-01T14:00:00.000Z–2026-11-01T23:00:00.000Z",
    ]);
  });

  test("on the day the clocks spring forward too", () => {
    // Sunday Mar 8 2026: EST → EDT. 9:00 EDT is 13:00Z.
    const slots = freeSlots({
      busy: [
        { start: d("2026-03-08T16:00:00Z"), end: d("2026-03-08T17:00:00Z") },
      ],
      since: d("2026-03-08T05:00:00Z"),
      until: d("2026-03-09T04:00:00Z"),
      durationMinutes: 60,
      timeZone: ny,
      hours: { startMinute: 9 * 60, endMinute: 18 * 60, days: [7] },
    });
    expect(show(slots)).toEqual([
      "2026-03-08T13:00:00.000Z–2026-03-08T16:00:00.000Z",
      "2026-03-08T17:00:00.000Z–2026-03-08T22:00:00.000Z",
    ]);
  });

  test("a fully booked day has nothing; a meeting longer than the day finds nothing", () => {
    expect(
      freeSlots({
        busy: [
          { start: d("2026-09-29T12:00:00Z"), end: d("2026-09-29T23:00:00Z") },
        ],
        since: d("2026-09-29T04:00:00Z"),
        until: d("2026-09-30T04:00:00Z"),
        durationMinutes: 15,
        timeZone: ny,
      }),
    ).toEqual([]);
    expect(
      freeSlots({
        busy: [],
        since: d("2026-09-29T04:00:00Z"),
        until: d("2026-09-30T04:00:00Z"),
        durationMinutes: 600,
        timeZone: ny,
      }),
    ).toEqual([]);
  });
});
