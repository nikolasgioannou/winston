import { z } from "zod";
import { validTimezone } from "./timezone";

const common = {
  startAt: z.iso.datetime(),
  timezone: z.string().refine(validTimezone),
};

function validRule(rule: string) {
  const seen = new Set<string>();
  const ranges: Record<string, [number, number, boolean?]> = {
    INTERVAL: [1, 1000],
    COUNT: [1, 10_000],
    BYMONTH: [1, 12],
    BYMONTHDAY: [-31, 31, true],
    BYHOUR: [0, 23],
    BYMINUTE: [0, 59],
    BYSETPOS: [-366, 366, true],
  };
  for (const part of rule.split(";")) {
    const [key, value] = part.split("=");
    if (!key || !value || seen.has(key)) return false;
    seen.add(key);
    if (key === "FREQ") continue;
    if (key === "UNTIL") {
      if (!/^\d{8}T\d{6}Z$/.test(value)) return false;
      continue;
    }
    if (key === "BYDAY" || key === "WKST") {
      const pattern =
        key === "WKST" ? /^(MO|TU|WE|TH|FR|SA|SU)$/ : /^(?:[+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)$/;
      if (!value.split(",").every((day) => pattern.test(day))) return false;
      if (key === "WKST" && value.includes(",")) return false;
      continue;
    }
    const range = ranges[key];
    if (!range) return false;
    if (["INTERVAL", "COUNT"].includes(key) && value.includes(",")) return false;
    if (
      !value
        .split(",")
        .every(
          (item) =>
            /^[+-]?\d+$/.test(item) &&
            Number(item) >= range[0] &&
            Number(item) <= range[1] &&
            (!range[2] || Number(item) !== 0),
        )
    )
      return false;
  }
  return !(seen.has("COUNT") && seen.has("UNTIL"));
}

export const scheduleTimingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), ...common }),
  z.strictObject({
    kind: z.literal("recurring"),
    ...common,
    rule: z
      .string()
      .max(1000)
      .regex(/^FREQ=(?:MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(?:;[A-Z]+=[A-Z0-9,+-]+)*$/)
      .refine(validRule, "Unsupported or invalid recurrence rule."),
  }),
]);

export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>;

export const scheduleRequestSchema = z.strictObject({
  key: z.string().min(1).max(200),
  objective: z.string().min(1).max(20_000),
  sourceMessageIds: z.array(z.uuid()).max(100),
  timing: scheduleTimingSchema,
});
export const scheduleSchema = scheduleRequestSchema.omit({ key: true }).extend({
  id: z.uuid(),
  ownerId: z.uuid(),
  revision: z.number().int().nonnegative(),
  state: z.enum(["active", "paused", "completed", "canceled"]),
  nextRunAt: z.iso.datetime().nullable(),
});
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export const scheduleListSchema = z.strictObject({
  items: z.array(scheduleSchema).max(100),
  next: z.uuid().nullable(),
});

export const ownerScheduleCreateSchema = scheduleRequestSchema
  .omit({ sourceMessageIds: true })
  .extend({
    key: z.string().min(1).max(196),
  });
export const ownerScheduleUpdateSchema = ownerScheduleCreateSchema.omit({ key: true }).extend({
  revision: scheduleSchema.shape.revision,
});
export const ownerScheduleCancelSchema = z.strictObject({
  revision: scheduleSchema.shape.revision,
});
