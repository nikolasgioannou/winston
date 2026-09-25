import { z } from "zod";
import { resolvedTargetSchema } from "./connection-targets";
import { validTimezone } from "./timezone";

const timezone = z.string().refine(validTimezone);
const instant = z.iso.datetime({ offset: true });
export const calendarReadTargetSchema = resolvedTargetSchema.extend({
  operation: z.literal("calendar.read"),
  calendarId: z.string().min(1).max(1024),
});
export const calendarEventIdSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/);
const windowSchema = z
  .strictObject({
    timeMin: instant,
    timeMax: instant,
    timezone,
    query: z.string().max(2000).default(""),
  })
  .refine((value) => {
    const duration = Date.parse(value.timeMax) - Date.parse(value.timeMin);
    return duration > 0 && duration <= 366 * 86_400_000;
  }, "Calendar windows must span no more than 366 days.");
export const calendarEventQuerySchema = z.strictObject({
  target: calendarReadTargetSchema,
  window: windowSchema,
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z
    .strictObject({
      connectionId: z.uuid(),
      calendarId: z.string().min(1).max(1024),
      window: windowSchema,
      pageToken: z.string().min(1).max(4096),
    })
    .optional(),
});
export const calendarEventRequestSchema = z.strictObject({
  target: calendarReadTargetSchema,
  id: calendarEventIdSchema,
});
export const calendarEventTimeSchema = z.union([
  z.strictObject({ date: z.iso.date(), timeZone: timezone.optional() }),
  z
    .strictObject({
      dateTime: z.union([instant, z.iso.datetime({ local: true })]),
      timeZone: timezone.optional(),
    })
    .refine(
      (value) => instant.safeParse(value.dateTime).success || Boolean(value.timeZone),
      "Local event times require a timezone.",
    ),
]);
export const calendarProviderEventSchema = z
  .object({
    id: calendarEventIdSchema,
    etag: z.string().min(1).max(1024).optional(),
    eventType: z.string().max(100).optional(),
    locked: z.boolean().optional(),
    recurrence: z.array(z.string().max(2000)).max(20).optional(),
    organizer: z
      .object({
        email: z.string().max(1024).optional(),
        self: z.boolean().optional(),
      })
      .optional(),
    status: z.enum(["confirmed", "tentative", "cancelled"]).default("confirmed"),
    summary: z.string().max(16384).optional(),
    description: z.string().max(100_000).optional(),
    location: z.string().max(16384).optional(),
    start: calendarEventTimeSchema.optional(),
    end: calendarEventTimeSchema.optional(),
    endTimeUnspecified: z.boolean().default(false),
    recurringEventId: calendarEventIdSchema.optional(),
    originalStartTime: calendarEventTimeSchema.optional(),
    transparency: z.enum(["opaque", "transparent"]).default("opaque"),
    attendees: z
      .array(
        z.object({
          email: z.string().max(1024).optional(),
          displayName: z.string().max(1024).optional(),
          self: z.boolean().optional(),
          optional: z.boolean().optional(),
          resource: z.boolean().optional(),
          comment: z.string().max(16384).optional(),
          additionalGuests: z.number().int().nonnegative().optional(),
          responseStatus: z.enum(["needsAction", "declined", "tentative", "accepted"]).optional(),
        }),
      )
      .max(2500)
      .default([]),
    attendeesOmitted: z.boolean().default(false),
  })
  .refine((event) => {
    if (event.status === "cancelled") return true;
    if (!event.start || !event.end) return false;
    if ("date" in event.start) return "date" in event.end && event.start.date < event.end.date;
    if (!("dateTime" in event.end)) return false;
    if (
      instant.safeParse(event.start.dateTime).success &&
      instant.safeParse(event.end.dateTime).success
    )
      return Date.parse(event.start.dateTime) <= Date.parse(event.end.dateTime);
    return true;
  }, "Active calendar events require compatible start and end boundaries.");
export const calendarEventPageSchema = z.object({
  timeZone: timezone.optional(),
  items: z.array(calendarProviderEventSchema).max(100).default([]),
  nextPageToken: z.string().min(1).max(4096).optional(),
});
export type CalendarEventQuery = z.input<typeof calendarEventQuerySchema>;
export type CalendarEventRequest = z.input<typeof calendarEventRequestSchema>;

export const calendarAvailabilityQuerySchema = z.strictObject({
  target: calendarReadTargetSchema,
  window: z.strictObject({ timeMin: instant, timeMax: instant, timezone }).refine((value) => {
    const duration = Date.parse(value.timeMax) - Date.parse(value.timeMin);
    return duration > 0 && duration <= 366 * 86_400_000;
  }, "Calendar windows must span no more than 366 days."),
});
export type CalendarAvailabilityQuery = z.input<typeof calendarAvailabilityQuerySchema>;

export const calendarAvailabilityResponseSchema = z.object({
  timeMin: instant,
  timeMax: instant,
  groups: z.record(z.string(), z.unknown()).optional(),
  calendars: z.record(
    z.string(),
    z.object({
      errors: z.array(z.unknown()).optional(),
      busy: z
        .array(
          z
            .object({ start: instant, end: instant })
            .refine((item) => Date.parse(item.start) < Date.parse(item.end)),
        )
        .max(10000),
    }),
  ),
});
