import { Hono } from "hono";
import { serviceRequestSchema } from "@winston/contracts/capabilities";
import { workspaceOperationSchema } from "@winston/contracts/workspace";
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
  const resourceId = path.match(/^\/api\/tasks\/workspaces\/([^/]+)\/authorize$/)?.[1];
  const result = serviceRequestSchema.safeParse({
    token: request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1],
    kind: "worker",
    subjectId: request.headers.get("X-Winston-Worker"),
    operation: "workspace:execute",
    resourceId,
  });
  return result.success ? result.data : null;
}

export function createWorkspaceTaskGroup(database: Database) {
  const router = new Hono<HttpEnvironment>();
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
