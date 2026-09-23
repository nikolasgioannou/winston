import { RRuleTemporal } from "rrule-temporal";
import { scheduleTimingSchema, type ScheduleTiming } from "@winston/contracts/schedules";

export class ScheduleEvaluationError extends Error {
  constructor() {
    super("Schedule is invalid or exceeds recurrence evaluation limits.");
  }
}

// Pure calculation: callers persist both the timing and returned instant. Never use
// the owner's current timezone to reinterpret an existing schedule.
export function nextScheduleOccurrence(
  input: ScheduleTiming,
  after: string,
  inclusive = false,
): string | null {
  try {
    const timing = scheduleTimingSchema.parse(input);
    const boundary = new Date(after);
    const start = new Date(timing.startAt);
    if (!Number.isFinite(boundary.getTime()) || !Number.isFinite(start.getTime()))
      throw new ScheduleEvaluationError();
    if (timing.kind === "once")
      return start > boundary || (inclusive && start.getTime() === boundary.getTime())
        ? start.toISOString()
        : null;

    const recurrence = new RRuleTemporal({
      rruleString: timing.rule,
      dtstart: {
        timeZoneId: timing.timezone,
        toString: () => `${start.toISOString()}[${timing.timezone}]`,
      },
      strict: true,
      cache: false,
      includeDtstart: false,
      maxIterations: 10_000,
      maxCandidateEvaluations: 10_000,
    });
    const next = recurrence.next(boundary, inclusive);
    return next ? new Date(next.epochMilliseconds).toISOString() : null;
  } catch {
    throw new ScheduleEvaluationError();
  }
}

export function recoverScheduleOccurrence(timing: ScheduleTiming, dueAt: string, now: string) {
  const due = new Date(dueAt);
  const current = new Date(now);
  if (!Number.isFinite(due.getTime()) || !Number.isFinite(current.getTime()))
    throw new ScheduleEvaluationError();
  if (due > current) return null;
  // One overdue occurrence, not a burst of notifications for every missed interval.
  return {
    dueAt: due.toISOString(),
    nextRunAt: nextScheduleOccurrence(timing, current.toISOString()),
  };
}
