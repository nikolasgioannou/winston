import { serviceRequestSchema } from "@winston/contracts/capabilities";
import type { WorkspaceIdentity } from "@winston/contracts/workspace";
import { workspaceCommandSchema } from "@winston/contracts/workspace-commands";
import { CommandError, type createCommandService } from "./commands";
import { boundedJson } from "./http-body";

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function createCommandHandler(
  identity: WorkspaceIdentity,
  service: ReturnType<typeof createCommandService>,
) {
  return async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/v1/commands/")) return null;
    const mode = path.slice("/v1/commands/".length);
    if (
      request.method !== "POST" ||
      !["start", "renew", "status", "cancel", "stdout", "stderr"].includes(mode)
    )
      return json({ error: "not_found" }, 404);
    const credential = serviceRequestSchema.safeParse({
      token: request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1],
      kind: "worker",
      subjectId: request.headers.get("X-Winston-Worker"),
      operation: ["status", "stdout", "stderr"].includes(mode)
        ? "workspace:observe"
        : mode === "cancel"
          ? "workspace:cancel"
          : "workspace:execute",
      resourceId: identity.workspaceId,
    });
    if (!credential.success) return json({ error: "unauthorized" }, 401);
    let input;
    try {
      const body = await boundedJson(request.body, 16_384);
      input =
        mode === "start" || mode === "renew"
          ? workspaceCommandSchema.parse(body)
          : workspaceCommandSchema.shape.operation.parse(body);
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const operation = "operation" in input ? input.operation : input;
    if (
      operation.identity.ownerId !== identity.ownerId ||
      operation.identity.workspaceId !== identity.workspaceId
    )
      return json({ error: "forbidden" }, 403);
    try {
      if (mode === "stdout" || mode === "stderr") {
        const result = await service.output(credential.data, operation, mode);
        return result
          ? new Response(result.stream, {
              headers: {
                "Cache-Control": "no-store",
                "Content-Type": "application/octet-stream",
                "Content-Length": String(result.output.bytes),
                "X-Winston-Output-SHA256": result.output.sha256,
              },
            })
          : json({ error: "not_found" }, 404);
      }
      const record =
        "operation" in input
          ? await (mode === "start"
              ? service.start(credential.data, input)
              : service.renew(credential.data, input))
          : await service.control(credential.data, input);
      return record ? json(record) : json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof CommandError) {
        const status =
          error.code === "forbidden" ? 403 : error.code === "authority_unavailable" ? 503 : 409;
        return json({ error: error.code }, status);
      }
      return json({ error: "operation_unavailable" }, 409);
    }
  };
}
