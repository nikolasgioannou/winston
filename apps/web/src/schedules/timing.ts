import { Temporal } from "@js-temporal/polyfill";
import type { Schedule, ScheduleTiming } from "@winston/contracts/schedules";

export type Repeat = "keep" | "once" | "daily" | "weekly" | "monthly";
export type ScheduleDraft = {
  objective: string;
  local: string;
  timezone: string;
  repeat: Repeat;
  occurrence: "" | "earlier" | "later";
};

export function localTime(schedule: Schedule) {
  return Temporal.Instant.from(schedule.timing.startAt)
    .toZonedDateTimeISO(schedule.timing.timezone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}

export function resolveLocalTime(local: string, timezone: string) {
  const plain = Temporal.PlainDateTime.from(local);
  const earlier = plain.toZonedDateTime(timezone, { disambiguation: "earlier" });
  const later = plain.toZonedDateTime(timezone, { disambiguation: "later" });
  if (!earlier.toPlainDateTime().equals(plain) || !later.toPlainDateTime().equals(plain)) {
    throw new Error("This time is skipped by a clock change. Choose another time.");
  }
  return {
    ambiguous: earlier.epochNanoseconds !== later.epochNanoseconds,
    earlier: earlier.toInstant().toString(),
    later: later.toInstant().toString(),
    earlierOffset: earlier.offset,
    laterOffset: later.offset,
  };
}

export function scheduleChange(original: Schedule, draft: ScheduleDraft) {
  let startAt = original.timing.startAt;
  if (draft.local !== localTime(original) || draft.timezone !== original.timing.timezone) {
    const resolved = resolveLocalTime(draft.local, draft.timezone);
    if (resolved.ambiguous && !draft.occurrence)
      throw new Error("This time happens twice. Choose which occurrence to use.");
    startAt = draft.occurrence === "later" ? resolved.later : resolved.earlier;
  }
  const common = { startAt, timezone: draft.timezone };
  const timing: ScheduleTiming =
    draft.repeat === "keep"
      ? { ...original.timing, ...common }
      : draft.repeat === "once"
        ? { ...common, kind: "once" }
        : {
            ...common,
            kind: "recurring",
            rule: `FREQ=${draft.repeat.toUpperCase()}`,
          };
  return { objective: draft.objective, timing, revision: original.revision };
}
