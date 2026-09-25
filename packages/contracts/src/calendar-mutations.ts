import { z } from "zod";
import {
  calendarEventIdSchema,
  calendarEventTimeSchema,
  calendarProviderEventSchema,
  calendarReadTargetSchema,
} from "./calendar";
import { resolvedTargetSchema } from "./connection-targets";
import { timestampSnapshot, validTimezone } from "./timezone";

const timezone = z.string().refine(validTimezone);
const instant = z.iso.datetime({ offset: true });
export const calendarMutationEtagSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^"[^"\r\n]+"$/);

function matchesTimezone(value: string, zone: string) {
  if (!validTimezone(zone)) return false;
  if (value.endsWith("Z")) return true;
  const offset = value.slice(-6);
  return timestampSnapshot(new Date(value), zone).offset === offset;
}

export const calendarMutationTimingSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("all-day"),
      start: z.iso.date(),
      end: z.iso.date(),
      timezone,
    })
    .refine((value) => value.start < value.end, "All-day end dates are exclusive."),
  z
    .strictObject({
      kind: z.literal("timed"),
      start: instant,
      end: instant,
      timezone,
    })
    .refine(
      (value) =>
        Date.parse(value.start) < Date.parse(value.end) &&
        matchesTimezone(value.start, value.timezone) &&
        matchesTimezone(value.end, value.timezone),
      "Event instants must increase and their explicit offsets must match the selected timezone.",
    ),
]);

const attendees = z
  .array(
    z.strictObject({
      email: z.email().max(1024),
      displayName: z.string().max(1024).optional(),
      optional: z.boolean().optional(),
    }),
  )
  .max(200)
  .refine(
    (value) => new Set(value.map((item) => item.email.toLowerCase())).size === value.length,
    "Attendees must be unique.",
  );

// Google validates recurrence syntax. Bound the exact lines and exclude DTSTART/DTEND:
// event timing belongs exclusively to the separately reviewed start/end fields.
export const calendarRecurrenceSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(2000)
      .regex(
        /^(?:RRULE:|EXRULE:|(?:RDATE|EXDATE)(?:;TZID=[A-Za-z0-9_+\-/]+)?(?:;VALUE=DATE)?:)[^\r\n]+$/,
      ),
  )
  .max(20);

export const calendarMutationFieldsSchema = z.strictObject({
  summary: z.string().min(1).max(1024),
  description: z.string().max(16_000),
  location: z.string().max(2048),
  timing: calendarMutationTimingSchema,
  attendees,
  recurrence: calendarRecurrenceSchema,
  transparency: z.enum(["opaque", "transparent"]),
});

export const calendarMutationChangesSchema = calendarMutationFieldsSchema
  .partial()
  .refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    "At least one event change is required.",
  );

export const calendarMutationScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("single") }),
  z.strictObject({ kind: z.literal("series") }),
  z.strictObject({
    kind: z.literal("instance"),
    recurringEventId: calendarEventIdSchema,
    originalStartTime: calendarEventTimeSchema,
  }),
]);

const target = resolvedTargetSchema.extend({
  operation: z.literal("calendar.write"),
  calendarId: z.string().min(1).max(1024),
});
const common = {
  target,
  sendUpdates: z.enum(["all", "externalOnly", "none"]),
};
const existing = {
  ...common,
  eventId: calendarEventIdSchema,
  etag: calendarMutationEtagSchema,
  scope: calendarMutationScopeSchema,
};

export const calendarMutationRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("create"), event: calendarMutationFieldsSchema }),
  z.strictObject({
    ...existing,
    kind: z.literal("update"),
    changes: calendarMutationChangesSchema,
  }),
  z.strictObject({ ...existing, kind: z.literal("delete") }),
  z.strictObject({
    ...existing,
    kind: z.literal("rsvp"),
    response: z.enum(["accepted", "tentative", "declined", "needsAction"]),
  }),
]);

export type CalendarMutationRequest = z.infer<typeof calendarMutationRequestSchema>;
export type CalendarMutationTiming = z.infer<typeof calendarMutationTimingSchema>;

export const calendarMutationOperationIdSchema = z.uuid();
export const calendarMutationSnapshotSchema = z
  .strictObject({
    source: calendarReadTargetSchema,
    event: calendarProviderEventSchema,
    trust: z.literal("untrusted_external_content").optional(),
  })
  .refine(
    (snapshot) =>
      snapshot.event.attendees.every((attendee) => z.email().safeParse(attendee.email).success),
    "Every affected attendee must have a complete email address.",
  );
export type CalendarMutationSnapshot = z.infer<typeof calendarMutationSnapshotSchema>;

const intentTarget = {
  accountId: z.uuid(),
  calendarId: z.string().min(1).max(1024),
};
export const calendarMutationIntentSchema = z.discriminatedUnion("kind", [
  calendarMutationRequestSchema.options[0].omit({ target: true }).extend(intentTarget),
  calendarMutationRequestSchema.options[1].omit({ target: true }).extend(intentTarget),
  calendarMutationRequestSchema.options[2].omit({ target: true }).extend(intentTarget),
  calendarMutationRequestSchema.options[3].omit({ target: true }).extend(intentTarget),
]);
export const calendarMutationPlanSchema = z.strictObject({
  version: z.literal(1),
  operationId: calendarMutationOperationIdSchema,
  request: calendarMutationRequestSchema,
  eventId: calendarEventIdSchema,
  method: z.enum(["POST", "PATCH", "DELETE"]),
  path: z.string().min(1).max(8192),
  ifMatch: calendarMutationEtagSchema.nullable(),
  sendUpdates: z.enum(["all", "externalOnly", "none"]),
  body: z.record(z.string(), z.json()).nullable(),
  before: calendarProviderEventSchema.nullable(),
  potentialNotificationRecipients: z.array(z.email()).max(5000),
});
export const calendarMutationArgumentsSchema = z.strictObject({
  intent: calendarMutationIntentSchema,
  plan: calendarMutationPlanSchema,
});
export type CalendarMutationIntent = z.infer<typeof calendarMutationIntentSchema>;
export type CalendarMutationPlan = z.infer<typeof calendarMutationPlanSchema>;

export const calendarMutationInputSchema = z.strictObject({
  key: z.string().min(1).max(100),
  intent: calendarMutationIntentSchema,
});
export type CalendarMutationInput = z.infer<typeof calendarMutationInputSchema>;
