const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * ISO 8601 local time with an explicit offset, to the second, e.g.
 * `2026-09-26T14:03:12-07:00`. Depends only on its inputs, never the process's
 * time zone. Throws a RangeError for an unknown IANA time zone.
 */
export function formatInTimeZone(date: Date, timeZone: string) {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date))
    parts[type] = value;
  // "GMT-07:00", or plain "GMT" at a zero offset.
  const offset = (parts.timeZoneName ?? "GMT").slice(3) || "+00:00";
  return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}T${parts.hour ?? ""}:${parts.minute ?? ""}:${parts.second ?? ""}${offset}`;
}

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A time as agents read it in envelopes: ISO 8601 with its offset, then the
 * weekday, e.g. `2026-10-02T18:12:44-04:00 (Friday)`. Working out a weekday
 * from a bare date is the date maths models most often slip on, so it's
 * spelled out. Deterministic, like `formatInTimeZone`.
 */
export function formatEnvelopeTime(date: Date, timeZone: string) {
  let weekday = weekdayFormatters.get(timeZone);
  if (!weekday) {
    weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" });
    weekdayFormatters.set(timeZone, weekday);
  }
  return `${formatInTimeZone(date, timeZone)} (${weekday.format(date)})`;
}

/**
 * The runtime's canonical name for an IANA time zone (`america/new_york` →
 * `America/New_York`), or undefined if it doesn't know it.
 */
export function canonicalTimeZone(zone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
    }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** Whether the runtime knows `zone` as a time zone. */
export const isTimeZone = (zone: string) =>
  canonicalTimeZone(zone) !== undefined;
