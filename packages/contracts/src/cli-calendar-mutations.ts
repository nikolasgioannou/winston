import { z } from "zod";
import { calendarMutationIntentSchema, calendarMutationInputSchema } from "./calendar-mutations";

const common = { version: z.literal(1), key: z.string().min(1).max(100) };
export const cliCalendarReconciliationRequestSchema = z.strictObject({
  ...common,
  command: z.literal("calendar.reconcile"),
  id: z.uuid(),
});
export type CliCalendarReconciliationRequest = z.infer<
  typeof cliCalendarReconciliationRequestSchema
>;
export const cliCalendarMutationRequestSchema = z.discriminatedUnion("command", [
  calendarMutationIntentSchema.options[0]
    .omit({ kind: true })
    .extend({ ...common, command: z.literal("calendar.create") }),
  calendarMutationIntentSchema.options[1]
    .omit({ kind: true })
    .extend({ ...common, command: z.literal("calendar.update") }),
  calendarMutationIntentSchema.options[2]
    .omit({ kind: true })
    .extend({ ...common, command: z.literal("calendar.delete") }),
]);
export type CliCalendarMutationRequest = z.infer<typeof cliCalendarMutationRequestSchema>;

export function calendarMutationInputFromCli(input: CliCalendarMutationRequest) {
  const request = cliCalendarMutationRequestSchema.parse(input);
  const target = {
    accountId: request.accountId,
    calendarId: request.calendarId,
    sendUpdates: request.sendUpdates,
  };
  const intent =
    request.command === "calendar.create"
      ? { ...target, kind: "create", event: request.event }
      : {
          ...target,
          kind: request.command === "calendar.update" ? "update" : "delete",
          eventId: request.eventId,
          etag: request.etag,
          scope: request.scope,
          ...(request.command === "calendar.update" ? { changes: request.changes } : {}),
        };
  return calendarMutationInputSchema.parse({ key: request.key, intent });
}
