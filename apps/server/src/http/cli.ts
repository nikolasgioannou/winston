import { Hono } from "hono";
import { cliRequestSchema } from "@winston/contracts/cli";
import { serviceRequestSchema } from "@winston/contracts/capabilities";
import type { createDatabase, OwnerTransaction } from "@winston/adapters/database";
import type { HttpEnvironment, Identity } from "./app";
import { parseJson, RequestError } from "./errors";

function credential(request: Request) {
  if (new URL(request.url).pathname !== "/api/tasks/cli") return null;
  const result = serviceRequestSchema.safeParse({
    token: request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1],
    kind: "workspace",
    subjectId: request.headers.get("X-Winston-Workspace"),
    operation: "gateway:read",
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

export function createCliTaskGroup(database: Database) {
  const router = new Hono<HttpEnvironment>();
  router.post("/cli", async (context) => {
    const identity = context.get("identity");
    const authority = credential(context.req.raw);
    if (identity.kind !== "task" || !authority) throw new RequestError("unauthorized");
    const request = await parseJson(context, cliRequestSchema);
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
