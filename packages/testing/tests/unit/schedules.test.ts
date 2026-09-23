import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  nextScheduleOccurrence,
  recoverScheduleOccurrence,
  ScheduleEvaluationError,
} from "@winston/adapters/schedules";
import { scheduleTimingSchema, type ScheduleTiming } from "@winston/contracts/schedules";

test("one-shot reminders keep their exact instant and have explicit boundary behavior", () => {
  const timing: ScheduleTiming = {
    kind: "once",
    startAt: "2026-11-01T06:30:00.000Z",
    timezone: "America/New_York",
  };
  assert.equal(nextScheduleOccurrence(timing, "2026-11-01T05:30:00.000Z"), timing.startAt);
  assert.equal(nextScheduleOccurrence(timing, timing.startAt), null);
  assert.equal(nextScheduleOccurrence(timing, timing.startAt, true), timing.startAt);
  assert.deepEqual(recoverScheduleOccurrence(timing, timing.startAt, "2026-11-02T00:00:00.000Z"), {
    dueAt: timing.startAt,
    nextRunAt: null,
  });
});

test("recurring wall times omit the spring gap and emit the repeated hour once", () => {
  const spring: ScheduleTiming = {
    kind: "recurring",
    startAt: "2026-03-07T07:30:00.000Z",
    timezone: "America/New_York",
    rule: "FREQ=DAILY",
  };
  assert.equal(nextScheduleOccurrence(spring, spring.startAt), "2026-03-09T06:30:00.000Z");
  const fall: ScheduleTiming = {
    ...spring,
    startAt: "2026-10-31T05:30:00.000Z",
  };
  const repeatedDay = nextScheduleOccurrence(fall, fall.startAt);
  assert.equal(repeatedDay, "2026-11-01T05:30:00.000Z");
  assert.equal(nextScheduleOccurrence(fall, repeatedDay), "2026-11-02T06:30:00.000Z");
});

test("weekday recurrence retains its timezone and coalesces missed work", () => {
  const timing: ScheduleTiming = {
    kind: "recurring",
    startAt: "2026-03-06T14:00:00.000Z",
    timezone: "America/New_York",
    rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  };
  assert.equal(nextScheduleOccurrence(timing, timing.startAt), "2026-03-09T13:00:00.000Z");
  assert.deepEqual(recoverScheduleOccurrence(timing, timing.startAt, "2026-03-11T18:00:00.000Z"), {
    dueAt: timing.startAt,
    nextRunAt: "2026-03-12T13:00:00.000Z",
  });
  assert.equal(recoverScheduleOccurrence(timing, timing.startAt, "2026-03-05T00:00:00.000Z"), null);
});

test("finite, monthly, invalid and impossible recurrences terminate predictably", () => {
  const timing: ScheduleTiming = {
    kind: "recurring",
    startAt: "2026-01-31T09:00:00.000Z",
    timezone: "UTC",
    rule: "FREQ=MONTHLY;COUNT=2",
  };
  const last = nextScheduleOccurrence(timing, timing.startAt);
  assert.equal(last, "2026-03-31T09:00:00.000Z");
  assert.equal(nextScheduleOccurrence(timing, last), null);
  assert.equal(scheduleTimingSchema.safeParse({ ...timing, rule: "FREQ=SECONDLY" }).success, false);
  assert.throws(
    () => nextScheduleOccurrence({ ...timing, rule: "FREQ=DAILY;BOGUS=1" }, timing.startAt),
    ScheduleEvaluationError,
  );
  assert.throws(
    () =>
      nextScheduleOccurrence(
        { ...timing, rule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30" },
        timing.startAt,
      ),
    ScheduleEvaluationError,
  );
});
