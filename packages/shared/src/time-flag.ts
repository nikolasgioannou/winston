/**
 * The times the `winston` CLI takes in its flags (docs/design.md §11):
 * ISO 8601, `now`, or a duration from now. Nothing else. Winston knows the
 * current moment and the user's offset from every envelope, so he writes
 * exact times; the one thing this adds is the user's zone for a time
 * written without an offset, with Temporal's zone math. Anything else is an
 * error with the accepted forms, never a guess.
 */

/** Which way a bare duration points: `--since 3d` looks back, `--expires 3d` ahead. */
export type Direction = "past" | "future";

export const acceptedTimeForms =
  "Times are ISO 8601: a date (2026-10-08) or a date and time (2026-10-08T15:00), both in the user's time zone; add an offset for a time somewhere else (2026-10-08T17:40+03:00, or Z). Or now, or a duration from now (30m, 2h, 3d, 1w).";

export class TimeParseError extends Error {
  readonly hint = acceptedTimeForms;
}

const units: Record<string, "minutes" | "hours" | "days" | "weeks"> = {
  m: "minutes",
  min: "minutes",
  mins: "minutes",
  minute: "minutes",
  minutes: "minutes",
  h: "hours",
  hr: "hours",
  hrs: "hours",
  hour: "hours",
  hours: "hours",
  d: "days",
  day: "days",
  days: "days",
  w: "weeks",
  week: "weeks",
  weeks: "weeks",
};

const isoPattern =
  /^(\d{4})-(\d{2})-(\d{2})(?:t(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(z|[+-]\d{2}:\d{2})?$/;
const durationPattern = /^(\d+)\s*([a-z]+)$/;

/** A wall-clock time in `timeZone` as an instant, refusing times that clocks skip or repeat. */
function inZone(
  date: Temporal.PlainDate,
  time: { hour: number; minute: number; second: number },
  timeZone: string,
  input: string,
) {
  try {
    return Temporal.ZonedDateTime.from(
      { year: date.year, month: date.month, day: date.day, ...time, timeZone },
      { disambiguation: "reject" },
    ).epochMilliseconds;
  } catch {
    throw new TimeParseError(
      `"${input}" doesn't exist or happens twice in ${timeZone}, because the clocks change then. Give an offset, e.g. 2026-11-01T01:30-04:00.`,
    );
  }
}

export function parseTimeFlag(
  input: string,
  options: { timeZone: string; direction: Direction; now?: Date },
) {
  const text = input.trim().toLowerCase();
  const now = Temporal.Instant.fromEpochMilliseconds(
    (options.now ?? new Date()).getTime(),
  );
  const fail = (): never => {
    throw new TimeParseError(`Couldn't understand the time "${input}".`);
  };

  if (text === "now") return new Date(now.epochMilliseconds);

  const iso = isoPattern.exec(text);
  if (iso) {
    const [, year, month, day, hour, minute, second, zone] = iso;
    if (zone) {
      try {
        return new Date(
          Temporal.Instant.from(input.trim().toUpperCase()).epochMilliseconds,
        );
      } catch {
        return fail();
      }
    }
    let date: Temporal.PlainDate;
    try {
      date = Temporal.PlainDate.from(
        { year: Number(year), month: Number(month), day: Number(day) },
        { overflow: "reject" },
      );
    } catch {
      return fail();
    }
    const time = {
      hour: Number(hour ?? 0),
      minute: Number(minute ?? 0),
      second: Number(second ?? 0),
    };
    if (time.hour > 23 || time.minute > 59 || time.second > 59) return fail();
    return new Date(inZone(date, time, options.timeZone, input));
  }

  const duration = durationPattern.exec(text);
  if (duration) {
    const [, amount = "", unitText = ""] = duration;
    const unit = units[unitText];
    if (!unit) return fail();
    const span = { [unit]: Number(amount) };
    // Days and weeks are calendar days in the zone (the same wall time across a DST change).
    const zoned = now.toZonedDateTimeISO(options.timeZone);
    const moved =
      options.direction === "future" ? zoned.add(span) : zoned.subtract(span);
    return new Date(moved.epochMilliseconds);
  }

  return fail();
}
