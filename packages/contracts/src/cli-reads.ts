import { z } from "zod";
import { gmailSearchSchema, gmailIdSchema } from "./gmail";
import { calendarEventQuerySchema, calendarEventIdSchema } from "./calendar";

const account = { version: z.literal(1), accountId: z.uuid() };
export const cliReadRequestSchema = z.discriminatedUnion("command", [
  gmailSearchSchema
    .omit({ target: true })
    .extend({ ...account, command: z.literal("gmail.search") }),
  z.strictObject({ ...account, command: z.literal("gmail.message"), id: gmailIdSchema }),
  z.strictObject({ ...account, command: z.literal("calendars.list") }),
  calendarEventQuerySchema.omit({ target: true }).extend({
    ...account,
    command: z.literal("calendar.events"),
    calendarId: z.string().min(1).max(1024),
  }),
  z.strictObject({
    ...account,
    command: z.literal("calendar.event"),
    calendarId: z.string().min(1).max(1024),
    id: calendarEventIdSchema,
  }),
]);
export type CliReadRequest = z.infer<typeof cliReadRequestSchema>;
