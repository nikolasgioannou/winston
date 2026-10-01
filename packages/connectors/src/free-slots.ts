/**
 * Free time for scheduling (docs/design.md §11 `calendar free`): the gaps
 * between busy blocks, inside working hours in the user's time zone, at
 * least as long as the meeting. Pure, so it's tested hard, DST days included.
 *
 * Working hours are wall-clock times in the user's zone, so a 9:00–18:00 day
 * is nine hours of instants on most days and still 9:00–18:00 on the days the
 * clocks change. Weekends are left out unless asked for.
 */

export interface Interval {
  start: Date;
  end: Date;
}

export interface WorkingHours {
  /** Minutes after midnight, e.g. 9 * 60. */
  startMinute: number;
  endMinute: number;
  /** ISO weekdays to include: 1 = Monday … 7 = Sunday. */
  days: number[];
}

export const defaultWorkingHours: WorkingHours = {
  startMinute: 9 * 60,
  endMinute: 18 * 60,
  days: [1, 2, 3, 4, 5],
};

/** Busy blocks merged into non-overlapping intervals, earliest first. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else merged.push({ start: interval.start, end: interval.end });
  }
  return merged;
}

/** One day's working window, as instants, in `timeZone`. */
function windowOn(
  date: Temporal.PlainDate,
  hours: WorkingHours,
  timeZone: string,
): Interval {
  const at = (minute: number) =>
    new Date(
      date
        .toZonedDateTime({
          timeZone,
          plainTime: Temporal.PlainTime.from({
            hour: Math.floor(minute / 60),
            minute: minute % 60,
          }),
        })
        .toInstant().epochMilliseconds,
    );
  return { start: at(hours.startMinute), end: at(hours.endMinute) };
}

/**
 * Free slots of at least `durationMinutes` between `since` and `until`,
 * inside working hours, avoiding every busy block. Slots are the whole free
 * stretch (so "10:00–12:30" when 30 minutes are asked for), earliest first.
 */
export function freeSlots({
  busy,
  since,
  until,
  durationMinutes,
  timeZone,
  hours = defaultWorkingHours,
}: {
  busy: Interval[];
  since: Date;
  until: Date;
  durationMinutes: number;
  timeZone: string;
  hours?: WorkingHours;
}): Interval[] {
  const blocks = mergeIntervals(busy);
  const minimum = durationMinutes * 60_000;
  const slots: Interval[] = [];
  const first = Temporal.Instant.fromEpochMilliseconds(since.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  const last = Temporal.Instant.fromEpochMilliseconds(until.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  for (
    let day = first;
    Temporal.PlainDate.compare(day, last) <= 0;
    day = day.add({ days: 1 })
  ) {
    if (!hours.days.includes(day.dayOfWeek)) continue;
    const window = windowOn(day, hours, timeZone);
    let cursor = new Date(Math.max(window.start.getTime(), since.getTime()));
    const end = new Date(Math.min(window.end.getTime(), until.getTime()));
    for (const block of blocks) {
      if (block.end <= cursor) continue;
      if (block.start >= end) break;
      if (block.start.getTime() - cursor.getTime() >= minimum)
        slots.push({ start: cursor, end: block.start });
      if (block.end > cursor) cursor = block.end;
    }
    if (end.getTime() - cursor.getTime() >= minimum)
      slots.push({ start: cursor, end });
  }
  return slots;
}
