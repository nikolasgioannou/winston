import { createHash } from "node:crypto";
import { serviceRequestSchema, type ServiceRequest } from "@winston/contracts/capabilities";
import {
  workspaceIdentitySchema,
  workspaceInspectionSchema,
  type WorkspaceIdentity,
  type WorkspaceOperation,
} from "@winston/contracts/workspace";
import type { openWorkspaceJournal } from "./journal";
import { boundedJson } from "./http-body";

type Options = {
  identity: WorkspaceIdentity;
  journal: ReturnType<typeof openWorkspaceJournal>;
  authorize: (credential: ServiceRequest, operation: WorkspaceOperation) => Promise<boolean>;
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function createWorkspaceHandler(options: Options) {
  const identity = workspaceIdentitySchema.parse(options.identity);
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      try {
        options.journal.assertPresent();
        return json({ status: "ok" });
      } catch {
        return json({ error: "storage_unavailable" }, 503);
      }
    }
    if (request.method !== "POST" || !["/v1/inspect", "/v1/status"].includes(path)) {
      return json({ error: "not_found" }, 404);
    }
    const credential = serviceRequestSchema.safeParse({
      token: request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1],
      kind: "worker",
      subjectId: request.headers.get("X-Winston-Worker"),
      operation: "workspace:execute",
      resourceId: identity.workspaceId,
    });
    if (!credential.success) return json({ error: "unauthorized" }, 401);

    let inspection;
    try {
      inspection = workspaceInspectionSchema.parse(await boundedJson(request.body, 16_384));
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const { operation, input } = inspection;
    if (
      operation.identity.ownerId !== identity.ownerId ||
      operation.identity.workspaceId !== identity.workspaceId
    )
      return json({ error: "forbidden" }, 403);
    if (operation.inputHash !== createHash("sha256").update(JSON.stringify(input)).digest("hex")) {
      return json({ error: "invalid_request" }, 400);
    }

    try {
      if (!(await options.authorize(credential.data, operation))) {
        return json({ error: "forbidden" }, 403);
      }
    } catch {
      return json({ error: "authority_unavailable" }, 503);
    }

    try {
      // There is no await between authorization, claiming and this read-only operation.
      // Future side effects must preserve this dispatch boundary and establish process ownership.
      if (path === "/v1/inspect") {
        const claim = options.journal.start(operation);
        if (claim.started) {
          options.journal.finish(operation, claim.completionToken, {
            state: "completed",
            result: JSON.stringify({ identity, home: options.journal.home }),
          });
        }
      }
      const record = options.journal.read(operation);
      return record ? json(record) : json({ error: "not_found" }, 404);
    } catch {
      // Never return raw filesystem, journal or credential errors over the protocol.
      return json({ error: "operation_unavailable" }, 409);
    }
  };
}
