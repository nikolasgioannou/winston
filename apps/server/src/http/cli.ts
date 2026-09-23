import { Hono } from "hono";
import {
  cliRequestSchema,
  cliReadRequestSchema,
  cliScheduleRequestSchema,
  type CliReadRequest,
  type CliResult,
} from "@winston/contracts/cli";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { serviceRequestSchema } from "@winston/contracts/capabilities";
import type { createDatabase, OwnerTransaction } from "@winston/adapters/database";
import type { HttpEnvironment, Identity } from "./app";
import { parseJson, RequestError } from "./errors";
import { publishFileResponse, type FilePublisher } from "./file-publication";
import type { FileRequest } from "../files/cli";

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

export function createCliTaskGroup(
  database: Database,
  read?: (
    credential: ServiceRequest,
    request: CliReadRequest,
    signal: AbortSignal,
  ) => Promise<CliResult>,
  publish?: FilePublisher,
  files?: (credential: ServiceRequest, request: FileRequest) => Promise<CliResult>,
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
