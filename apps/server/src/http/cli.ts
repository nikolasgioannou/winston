import { Hono } from "hono";
import {
  cliRequestSchema,
  cliReadRequestSchema,
  cliScheduleRequestSchema,
  cliResponsibilityRequestSchema,
  cliCalendarMutationRequestSchema,
  calendarMutationInputFromCli,
  cliGmailMutationRequestSchema,
  gmailMutationInputFromCli,
  type CliReadRequest,
  type CliResult,
  type CliDeviceRequest,
  type CliCalendarReconciliationRequest,
  type CliGmailReconciliationRequest,
} from "@winston/contracts/cli";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { serviceRequestSchema } from "@winston/contracts/capabilities";
import type { createDatabase, OwnerTransaction } from "@winston/adapters/database";
import type { HttpEnvironment, Identity } from "./app";
import { parseJson, RequestError } from "./errors";
import { publishFileResponse, type FilePublisher } from "./file-publication";
import type { FileRequest } from "../files/cli";
import type { CalendarMutationInput } from "@winston/contracts/calendar-mutations";
import type { GmailMutationInput } from "@winston/contracts/gmail-mutations";
import type { GmailLabelMutationInput } from "@winston/contracts/gmail-label-mutations";
import type { GmailTrashInput } from "@winston/contracts/gmail-trash";
import type { ArtifactStageRequest } from "@winston/contracts/artifacts";

function credential(request: Request) {
  const path = new URL(request.url).pathname;
  if (!["/api/tasks/cli", "/api/tasks/cli/control", "/api/tasks/files/publish"].includes(path))
    return null;
  const result = serviceRequestSchema.safeParse({
    token: request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1],
    kind: "workspace",
    subjectId: request.headers.get("X-Winston-Workspace"),
    operation: path === "/api/tasks/cli" ? "gateway:read" : "gateway:control",
    resourceId: request.headers.get("X-Winston-Workspace"),
  });
  return result.success ? result.data : null;
}

type Database = Pick<ReturnType<typeof createDatabase>, "authenticateService"> & {
  transaction<Result>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "cli">) => Promise<Result>,
  ): Promise<Result>;
};

type Handlers = {
  stage?: (
    credential: ServiceRequest,
    request: ArtifactStageRequest,
    signal: AbortSignal,
  ) => Promise<CliResult>;
  gmailTrash?: (
    credential: ServiceRequest,
    request: GmailTrashInput,
    signal: AbortSignal,
  ) => Promise<CliResult>;
  gmailLabelMutations?: (
    credential: ServiceRequest,
    request: GmailLabelMutationInput,
    signal: AbortSignal,
  ) => Promise<CliResult>;
  gmailReconciliation?: (
    credential: ServiceRequest,
    request: CliGmailReconciliationRequest,
    signal: AbortSignal,
  ) => Promise<CliResult>;
  gmailMutations?: (
    credential: ServiceRequest,
    request: GmailMutationInput,
    signal: AbortSignal,
  ) => Promise<CliResult>;
  calendarReconciliation?: (
    credential: ServiceRequest,
    request: CliCalendarReconciliationRequest,
    signal: AbortSignal,
  ) => Promise<CliResult>;
  read?: (
    credential: ServiceRequest,
    request: CliReadRequest,
    signal: AbortSignal,
  ) => Promise<CliResult>;
  publish?: FilePublisher;
  files?: (credential: ServiceRequest, request: FileRequest) => Promise<CliResult>;
  devices?: (
    credential: ServiceRequest,
    request: CliDeviceRequest,
    headers: Headers,
    signal: AbortSignal,
  ) => Promise<Response>;
  calendarMutations?: (
    credential: ServiceRequest,
    request: CalendarMutationInput,
    signal: AbortSignal,
  ) => Promise<CliResult>;
};

export function createCliTaskGroup(
  database: Database,
  {
    read,
    publish,
    stage,
    files,
    devices,
    calendarMutations,
    calendarReconciliation,
    gmailMutations,
    gmailReconciliation,
    gmailLabelMutations,
    gmailTrash,
  }: Handlers = {},
) {
  const router = new Hono<HttpEnvironment>();
  router.post("/files/publish", async (context) => {
    const identity = context.get("identity");
    const authority = credential(context.req.raw);
    if (identity.kind !== "task" || !authority) throw new RequestError("unauthorized");
    return publishFileResponse(context, authority, publish);
  });
  router.post("/cli/control", async (context) => {
    const identity = context.get("identity");
    const authority = credential(context.req.raw);
    if (identity.kind !== "task" || !authority) throw new RequestError("unauthorized");
    const request = await parseJson(context, cliRequestSchema);
    if (request.command === "files.stage") {
      const { version, key, id, revision } = request;
      return context.json(
        stage
          ? await stage(authority, { version, key, id, revision }, context.req.raw.signal)
          : { version: 1, status: "unavailable", message: "Artifact staging is not configured." },
      );
    }
    if (request.command === "gmail.trash" || request.command === "gmail.restore") {
      const { key, accountId, messageId } = request;
      return context.json(
        gmailTrash
          ? await gmailTrash(
              authority,
              {
                key,
                intent: {
                  kind: request.command === "gmail.trash" ? "message.trash" : "message.restore",
                  accountId,
                  messageId,
                },
              },
              context.req.raw.signal,
            )
          : {
              version: 1,
              status: "unavailable",
              message: "Gmail trash/restore is not configured.",
            },
      );
    }
    if (request.command === "gmail.modify") {
      const { key, accountId, messageId, addLabelIds, removeLabelIds } = request;
      return context.json(
        gmailLabelMutations
          ? await gmailLabelMutations(
              authority,
              { key, intent: { accountId, messageId, addLabelIds, removeLabelIds } },
              context.req.raw.signal,
            )
          : {
              version: 1,
              status: "unavailable",
              message: "Gmail label changes are not configured.",
            },
      );
    }
    if (request.command === "gmail.reconcile")
      return context.json(
        gmailReconciliation
          ? await gmailReconciliation(authority, request, context.req.raw.signal)
          : {
              version: 1,
              status: "unavailable",
              message: "Gmail reconciliation is not configured.",
            },
      );
    const gmail = cliGmailMutationRequestSchema.safeParse(request);
    if (gmail.success)
      return context.json(
        gmailMutations
          ? await gmailMutations(
              authority,
              gmailMutationInputFromCli(gmail.data),
              context.req.raw.signal,
            )
          : { version: 1, status: "unavailable", message: "Gmail mutations are not configured." },
      );
    if (request.command === "calendar.reconcile")
      return context.json(
        calendarReconciliation
          ? await calendarReconciliation(authority, request, context.req.raw.signal)
          : {
              version: 1,
              status: "unavailable",
              message: "Calendar reconciliation is not configured.",
            },
      );
    const calendar = cliCalendarMutationRequestSchema.safeParse(request);
    if (calendar.success)
      return context.json(
        calendarMutations
          ? await calendarMutations(
              authority,
              calendarMutationInputFromCli(calendar.data),
              context.req.raw.signal,
            )
          : {
              version: 1,
              status: "unavailable",
              message: "Calendar mutations are not configured.",
            },
      );
    if (
      request.command === "devices.command" ||
      request.command === "devices.read" ||
      request.command === "devices.write"
    )
      return devices
        ? devices(authority, request, context.req.raw.headers, context.req.raw.signal)
        : context.json({
            version: 1,
            status: "unavailable",
            message: "Device commands are not configured.",
          });
    const responsibility = cliResponsibilityRequestSchema.safeParse(request);
    if (responsibility.success)
      return context.json(
        await database.transaction(identity.ownerId, ({ cli }) =>
          cli.responsibility(authority, responsibility.data),
        ),
      );
    const schedule = cliScheduleRequestSchema.safeParse(request);
    if (schedule.success)
      return context.json(
        await database.transaction(identity.ownerId, ({ cli }) =>
          cli.schedule(authority, schedule.data),
        ),
      );
    if (request.command === "files.send")
      return context.json(
        files
          ? await files(authority, request)
          : { version: 1, status: "unavailable", message: "File delivery is not configured." },
      );
    const connected = cliReadRequestSchema.safeParse(request);
    if (connected.success && "key" in connected.data && connected.data.key) {
      return context.json(
        read
          ? await read(authority, connected.data, context.req.raw.signal)
          : { version: 1, status: "unavailable", message: "Connected reads are not configured." },
      );
    }
    if (request.command !== "operations.cancel" && request.command !== "accounts.connect")
      throw new RequestError("invalid_request");
    return context.json(
      await database.transaction(identity.ownerId, ({ cli }) =>
        request.command === "accounts.connect"
          ? cli.connect(authority, request)
          : cli.cancel(authority, request.id),
      ),
    );
  });
  router.post("/cli", async (context) => {
    const identity = context.get("identity");
    const authority = credential(context.req.raw);
    if (identity.kind !== "task" || !authority) throw new RequestError("unauthorized");
    const request = await parseJson(context, cliRequestSchema);
    if (
      request.command === "devices.read" ||
      request.command === "devices.write" ||
      request.command === "devices.command" ||
      cliCalendarMutationRequestSchema.safeParse(request).success ||
      cliGmailMutationRequestSchema.safeParse(request).success ||
      request.command === "calendar.reconcile" ||
      request.command === "gmail.reconcile" ||
      request.command === "gmail.modify" ||
      request.command === "gmail.trash" ||
      request.command === "gmail.restore" ||
      request.command === "files.stage"
    )
      throw new RequestError("invalid_request");
    if (request.command === "devices.result")
      return devices
        ? devices(authority, request, context.req.raw.headers, context.req.raw.signal)
        : context.json({
            version: 1,
            status: "unavailable",
            message: "Device results are not configured.",
          });
    const responsibility = cliResponsibilityRequestSchema.safeParse(request);
    if (responsibility.success)
      return context.json(
        await database.transaction(identity.ownerId, ({ cli }) =>
          cli.responsibility(authority, responsibility.data),
        ),
      );
    const schedule = cliScheduleRequestSchema.safeParse(request);
    if (schedule.success)
      return context.json(
        await database.transaction(identity.ownerId, ({ cli }) =>
          cli.schedule(authority, schedule.data),
        ),
      );
    if (request.command === "files.status")
      return context.json(
        files
          ? await files(authority, request)
          : { version: 1, status: "unavailable", message: "File delivery is not configured." },
      );
    const connected = cliReadRequestSchema.safeParse(request);
    if (connected.success) {
      return context.json(
        read
          ? await read(authority, connected.data, context.req.raw.signal)
          : { version: 1, status: "unavailable", message: "Connected reads are not configured." },
      );
    }
    const result = await database.transaction(identity.ownerId, ({ cli }) =>
      cli.execute(authority, request),
    );
    return context.json(result);
  });
  return {
    router,
    async authenticate(request: Request): Promise<Identity | null> {
      const input = credential(request);
      if (!input) return null;
      const authority = await database.authenticateService(input);
      return authority
        ? {
            kind: "task",
            ownerId: authority.ownerId,
            taskId: authority.taskId,
            revision: authority.revision,
          }
        : null;
    },
  };
}
