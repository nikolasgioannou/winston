/**
 * Times people type: `3d`, `tomorrow 9am`, `fri`, `2026-09-28T15:00`. They
 * resolve in the given time zone (the user's, never the VM's or server's),
 * with Temporal's zone math. The grammar is deliberately strict: anything
 * unclear is an error with the accepted forms, never a guess.
 */

/** Which way bare durations and weekday names point: `--since 3d` looks back, `--expires 3d` ahead. */
export type Direction = "past" | "future";

export const acceptedTimeForms =
  "Times can be ISO-8601 (2026-09-28, 2026-09-28T15:00, with Z or an offset like -04:00), durations (30m, 2h, 3d, 1w, in 2h, 2h ago), now, today, tomorrow, yesterday, or a weekday (fri, next mon, last friday), optionally with a time (9am, 9:30pm, 15:00, noon, midnight).";

export class TimeParseError extends Error {
  readonly hint = acceptedTimeForms;
}

const weekdays: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
};

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
const durationPattern = /^(in\s+)?(\d+)\s*([a-z]+)(\s+ago)?$/;
const timePattern = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;
const dayPattern = /^(?:(next|last)\s+)?([a-z]+)$/;

/** Wall-clock hours and minutes from `9am`, `9:30pm`, `15:00`, `noon` or `midnight`; undefined if it isn't a time. */
function parseTime(text: string) {
  if (text === "noon") return { hour: 12, minute: 0 };
  if (text === "midnight") return { hour: 0, minute: 0 };
  const match = timePattern.exec(text);
  if (!match) return undefined;
  const [, rawHour = "", rawMinute, meridiem] = match;
  let hour = Number(rawHour);
  const minute = rawMinute === undefined ? 0 : Number(rawMinute);
  if (minute > 59) return undefined;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (rawMinute === undefined || hour > 23) {
    // A bare "9" could be 9am or 9pm: say which.
    return undefined;
  }
  return { hour, minute };
}

/** The date `text` names, relative to `today`; undefined if it isn't a day. */
function parseDay(
  text: string,
  today: Temporal.PlainDate,
  direction: Direction,
) {
  if (text === "today") return today;
  if (text === "tomorrow") return today.add({ days: 1 });
  if (text === "yesterday") return today.subtract({ days: 1 });
  const match = dayPattern.exec(text);
  const weekday = match?.[2] === undefined ? undefined : weekdays[match[2]];
  if (weekday === undefined) return undefined;
  // A weekday never means today (say "today" for that): the next one ahead, or the last one back.
  const ahead =
    (match?.[1] ?? (direction === "future" ? "next" : "last")) === "next";
  const offset = ahead
    ? ((weekday - today.dayOfWeek + 6) % 7) + 1
    : ((today.dayOfWeek - weekday + 6) % 7) + 1;
  return ahead ? today.add({ days: offset }) : today.subtract({ days: offset });
}

/** A wall-clock time in `timeZone` as an instant, refusing times that clocks skip or repeat. */
function inZone(
  date: Temporal.PlainDate,
  time: { hour: number; minute: number; second?: number },
  timeZone: string,
  input: string,
) {
  try {
    return Temporal.ZonedDateTime.from(
      {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: time.hour,
        minute: time.minute,
        second: time.second ?? 0,
        timeZone,
      },
      { disambiguation: "reject" },
    ).epochMilliseconds;
  } catch {
    throw new TimeParseError(
      `"${input}" doesn't exist or happens twice in ${timeZone}, because the clocks change then. Give an offset, e.g. 2026-11-01T01:30-04:00.`,
    );
  }
}

export function parseHumanTime(
  input: string,
  options: { timeZone: string; direction: Direction; now?: Date },
) {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  const now = Temporal.Instant.fromEpochMilliseconds(
    (options.now ?? new Date()).getTime(),
  );
  const zonedNow = now.toZonedDateTimeISO(options.timeZone);
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
    const [, inPrefix, amount = "", unitText = "", agoSuffix] = duration;
    const unit = units[unitText];
    if (!unit || (inPrefix && agoSuffix)) return fail();
    const future = inPrefix
      ? true
      : agoSuffix
        ? false
        : options.direction === "future";
    const span = { [unit]: Number(amount) };
    // Days and weeks are calendar days in the zone (the same wall time across a DST change).
    const moved = future ? zonedNow.add(span) : zonedNow.subtract(span);
    return new Date(moved.epochMilliseconds);
  }

  // A day, a time, or both in either order ("tomorrow 9am", "9am tomorrow", "fri at noon").
  const today = zonedNow.toPlainDate();
  const words = text.replace(/ at /, " ").split(" ");
  for (let split = 0; split <= words.length; split += 1) {
    const [first, second] = [
      words.slice(0, split).join(" "),
      words.slice(split).join(" "),
    ];
    for (const [dayText, timeText] of [
      [first, second],
      [second, first],
    ] as const) {
      const day =
        dayText === "" ? today : parseDay(dayText, today, options.direction);
      const time =
        timeText === "" ? { hour: 0, minute: 0 } : parseTime(timeText);
      if (day && time && (dayText !== "" || timeText !== ""))
        return new Date(inZone(day, time, options.timeZone, input));
    }
  }
  return fail();
}
