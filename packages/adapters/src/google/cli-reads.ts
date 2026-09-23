import {
  cliReadRequestSchema,
  cliResultSchema,
  type CliReadRequest,
  type CliResult,
} from "@winston/contracts/cli";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { gmailReadTargetSchema } from "@winston/contracts/gmail";
import { calendarReadTargetSchema } from "@winston/contracts/calendar";
import { createGmailReader } from "./gmail";
import { createCalendarReader } from "./calendar-events";
import { createConnectionTargets } from "./targets";
import { GoogleReadError, type GoogleReadOptions } from "./read-request";

export function createConnectedReadGateway(options: GoogleReadOptions) {
  return async (
    credential: ServiceRequest,
    input: CliReadRequest,
    signal: AbortSignal,
  ): Promise<CliResult> => {
    const request = cliReadRequestSchema.parse(input);
    const authority = await options.database.authenticateService(credential);
    if (!authority || authority.operation !== "gateway:read")
      return {
        version: 1,
        status: "denied",
        message: "Task read authority is unavailable or expired.",
      };
    const authorize = async () => {
      const current = await options.database.authenticateService(credential);
      return (
        current?.ownerId === authority.ownerId &&
        current.taskId === authority.taskId &&
        current.revision === authority.revision &&
        current.generation === authority.generation
      );
    };
    const bound = { ...options, authorize };
    const targets = createConnectionTargets(options.database, options.google);
    try {
      let data: unknown;
      if (request.command === "calendars.list") {
        data = await targets.searchTargets(
          authority.ownerId,
          "calendar.read",
          signal,
          request.accountId,
        );
      } else {
        const operation = request.command.startsWith("gmail.") ? "gmail.read" : "calendar.read";
        const selected = await targets.resolve(
          authority.ownerId,
          {
            operation,
            explicit: {
              connectionId: request.accountId,
              calendarId: "calendarId" in request ? request.calendarId : null,
            },
            task: { id: authority.taskId, revision: authority.revision },
          },
          signal,
        );
        if (selected.status !== "resolved")
          return {
            version: 1,
            status: "unavailable",
            message: "The requested account or calendar is unavailable.",
          };
        switch (request.command) {
          case "gmail.search":
            data = await createGmailReader(bound).search(
              authority.ownerId,
              {
                target: gmailReadTargetSchema.parse(selected.target),
                query: request.query,
                limit: request.limit,
                ...(request.cursor ? { cursor: request.cursor } : {}),
              },
              signal,
            );
            break;
          case "gmail.message":
            data = await createGmailReader(bound).message(
              authority.ownerId,
              { target: gmailReadTargetSchema.parse(selected.target), id: request.id },
              signal,
            );
            break;
          case "calendar.events":
            data = await createCalendarReader(bound).events(
              authority.ownerId,
              {
                target: calendarReadTargetSchema.parse(selected.target),
                window: request.window,
                limit: request.limit,
                ...(request.cursor ? { cursor: request.cursor } : {}),
              },
              signal,
            );
            break;
          case "calendar.event":
            data = await createCalendarReader(bound).event(
              authority.ownerId,
              { target: calendarReadTargetSchema.parse(selected.target), id: request.id },
              signal,
            );
            break;
        }
      }
      if (!(await authorize()))
        return {
          version: 1,
          status: "denied",
          message: "Task read authority expired before completion.",
        };
      if (Buffer.byteLength(JSON.stringify(data)) > 900_000)
        return {
          version: 1,
          status: "unavailable",
          message: "The read result is too large. Narrow the query or request fewer results.",
        };
      return cliResultSchema.parse({ version: 1, status: "ok", data });
    } catch (error) {
      if (!(await authorize()))
        return {
          version: 1,
          status: "denied",
          message: "Task read authority is unavailable or expired.",
        };
      return {
        version: 1,
        status:
          error instanceof GoogleReadError && error.kind === "approval_required"
            ? "approval_required"
            : "unavailable",
        message:
          error instanceof GoogleReadError && error.kind === "approval_required"
            ? "This read requires approval and was not performed."
            : "The requested read could not be completed.",
      };
    }
  };
}
