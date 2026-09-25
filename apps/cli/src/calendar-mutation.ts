import {
  cliCalendarMutationRequestSchema,
  type CliCalendarMutationRequest,
} from "@winston/contracts/cli";

type Options = {
  account?: string;
  calendar?: string;
  key?: string;
  notify?: string;
  event?: string;
  changes?: string;
  id?: string;
  etag?: string;
  scope?: string;
};

export function parseCalendarMutation(
  command: CliCalendarMutationRequest["command"],
  values: Options,
) {
  return cliCalendarMutationRequestSchema.parse({
    version: 1,
    command,
    accountId: values.account,
    calendarId: values.calendar,
    key: values.key,
    sendUpdates: values.notify,
    ...(values.event === undefined ? {} : { event: JSON.parse(values.event) as unknown }),
    ...(values.changes === undefined ? {} : { changes: JSON.parse(values.changes) as unknown }),
    ...(values.id === undefined ? {} : { eventId: values.id }),
    ...(values.etag === undefined ? {} : { etag: values.etag }),
    ...(values.scope === undefined ? {} : { scope: JSON.parse(values.scope) as unknown }),
  });
}
