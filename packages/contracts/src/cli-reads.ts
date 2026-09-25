import { z } from "zod";
import { gmailSearchSchema, gmailDraftSearchSchema, gmailIdSchema } from "./gmail";
import {
  calendarEventQuerySchema,
  calendarEventIdSchema,
  calendarAvailabilityQuerySchema,
} from "./calendar";

const account = { version: z.literal(1), accountId: z.uuid() };
const read = { ...account, key: z.string().min(1).max(100).optional() };
export const cliReadRequestSchema = z.discriminatedUnion("command", [
  calendarAvailabilityQuerySchema.omit({ target: true }).extend({
    ...read,
    command: z.literal("calendar.availability"),
    calendarId: z.string().min(1).max(1024),
  }),
  gmailSearchSchema.omit({ target: true }).extend({ ...read, command: z.literal("gmail.search") }),
  z.strictObject({ ...read, command: z.literal("gmail.message"), id: gmailIdSchema }),
  gmailDraftSearchSchema
    .omit({ target: true })
    .extend({ ...read, command: z.literal("gmail.drafts") }),
  z.strictObject({ ...read, command: z.literal("gmail.draft"), id: gmailIdSchema }),
  z.strictObject({ ...account, command: z.literal("calendars.list") }),
  calendarEventQuerySchema.omit({ target: true }).extend({
    ...read,
    command: z.literal("calendar.events"),
    calendarId: z.string().min(1).max(1024),
  }),
  z.strictObject({
    ...read,
    command: z.literal("calendar.event"),
    calendarId: z.string().min(1).max(1024),
    id: calendarEventIdSchema,
  }),
]);
export type CliReadRequest = z.infer<typeof cliReadRequestSchema>;
