import { Hono } from "hono";
import { serviceRequestSchema } from "@winston/contracts/capabilities";
import { workspaceOperationSchema } from "@winston/contracts/workspace";
import { workspaceCommandSchema } from "@winston/contracts/workspace-commands";
import type { CliAuthority } from "@winston/contracts/cli";
import type { createDatabase, OwnerTransaction } from "@winston/adapters/database";
import type { HttpEnvironment, Identity } from "./app";
import { parseJson, RequestError } from "./errors";

type Database = Pick<ReturnType<typeof createDatabase>, "authenticateService"> & {
  transaction<Result>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "workspaces">) => Promise<Result>,
  ): Promise<Result>;
};

function credential(request: Request) {
  const path = new URL(request.url).pathname;
  const match = path.match(
    /^\/api\/tasks\/workspaces\/([^/]+)\/(authorize|authorize-command|authorize-cli|authorize-observe|authorize-cancel)$/,
  );
  if (!match) return null;
  const operation =
    match[2] === "authorize-observe"
      ? "workspace:observe"
      : match[2] === "authorize-cancel"
        ? "workspace:cancel"
        : "workspace:execute";
  const result = serviceRequestSchema.safeParse({
    token: request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1],
    kind: "worker",
    subjectId: request.headers.get("X-Winston-Worker"),
    operation,
    resourceId: match[1],
  });
  return result.success ? result.data : null;
}

export function createWorkspaceTaskGroup(
  database: Database,
  environment: CliAuthority["environment"] = "local",
) {
  const router = new Hono<HttpEnvironment>();
  router.post("/workspaces/:id/authorize-cli", async (context) => {
    const identity = context.get("identity");
    const request = credential(context.req.raw);
    if (identity.kind !== "task" || !request) throw new RequestError("unauthorized");
    const command = await parseJson(context, workspaceCommandSchema);
    const result = await database.transaction(identity.ownerId, ({ workspaces }) =>
      workspaces.issueCli(
        request,
        command,
        environment,
        context.req.header("X-Winston-CLI-Control") === "1",
      ),
    );
    if (!result) throw new RequestError("forbidden");
    return context.json(result);
  });
  router.post("/workspaces/:id/authorize", async (context) => {
    const identity = context.get("identity");
    const request = credential(context.req.raw);
    if (identity.kind !== "task" || !request) throw new RequestError("unauthorized");
    const operation = await parseJson(context, workspaceOperationSchema);
    const result = await database.transaction(identity.ownerId, ({ workspaces }) =>
      workspaces.authorize(request, operation),
    );
    if (!result) throw new RequestError("forbidden");
    return context.json(result);
  });
  router.post("/workspaces/:id/authorize-command", async (context) => {
    const identity = context.get("identity");
    const request = credential(context.req.raw);
    if (identity.kind !== "task" || !request) throw new RequestError("unauthorized");
    const command = await parseJson(context, workspaceCommandSchema);
    const result = await database.transaction(identity.ownerId, ({ workspaces }) =>
      workspaces.authorizeCommand(request, command),
    );
    if (!result) throw new RequestError("forbidden");
    return context.json(result);
  });
  for (const mode of ["observe", "cancel"] as const) {
    router.post(`/workspaces/:id/authorize-${mode}`, async (context) => {
      const identity = context.get("identity");
      const request = credential(context.req.raw);
      if (identity.kind !== "task" || !request) throw new RequestError("unauthorized");
      const operation = await parseJson(context, workspaceOperationSchema);
      const result = await database.transaction(identity.ownerId, ({ workspaces }) =>
        workspaces.authorizeControl(request, operation),
      );
      if (!result) throw new RequestError("forbidden");
      return context.json(result);
    });
  }
  return {
    router,
    async authenticate(request: Request): Promise<Identity | null> {
      const input = credential(request);
      if (!input) return null;
      const authority = await database.authenticateService(input);
      if (!authority) return null;
      return {
        kind: "task",
        ownerId: authority.ownerId,
        taskId: authority.taskId,
        revision: authority.revision,
      };
    },
  };
}
