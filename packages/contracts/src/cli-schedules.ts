import { z } from "zod";
import { scheduleTimingSchema, scheduleRequestSchema } from "./schedules";

const base = { version: z.literal(1) };
const timing = {
  objective: scheduleRequestSchema.shape.objective,
  startAt: scheduleTimingSchema.options[0].shape.startAt,
  timezone: scheduleTimingSchema.options[0].shape.timezone.optional(),
  rule: scheduleTimingSchema.options[1].shape.rule.optional(),
};
const identity = { id: z.uuid() };
const revision = { ...identity, revision: z.number().int().nonnegative() };

export const cliScheduleRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({
    ...base,
    ...timing,
    command: z.literal("schedules.create"),
    key: z.string().min(1).max(100),
    responsibility: scheduleRequestSchema.shape.responsibility,
  }),
  z.strictObject({ ...base, command: z.literal("schedules.list"), after: z.uuid().optional() }),
  z.strictObject({ ...base, ...identity, command: z.literal("schedules.inspect") }),
  z.strictObject({ ...base, ...revision, ...timing, command: z.literal("schedules.update") }),
  z.strictObject({ ...base, ...revision, command: z.literal("schedules.cancel") }),
  z.strictObject({ ...base, ...revision, command: z.literal("schedules.pause") }),
  z.strictObject({ ...base, ...revision, command: z.literal("schedules.resume") }),
]);
export type CliScheduleRequest = z.infer<typeof cliScheduleRequestSchema>;

export function isScheduleMutation(command: string) {
  return [
    "schedules.create",
    "schedules.update",
    "schedules.cancel",
    "schedules.pause",
    "schedules.resume",
  ].includes(command);
}
