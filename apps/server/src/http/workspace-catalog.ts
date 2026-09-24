import { Hono } from "hono";
import { registeredWorkspaceSchema } from "@winston/contracts/workspace";
import type { OwnerTransaction } from "@winston/adapters/database";
import type { HttpEnvironment } from "./app";
import { RequestError } from "./errors";

export function createWorkspaceOwnerRouter(database: {
  transaction<T>(
    ownerId: string,
    work: (scope: { workspaces: Pick<OwnerTransaction["workspaces"], "list"> }) => Promise<T>,
  ): Promise<T>;
}) {
  const router = new Hono<HttpEnvironment>();
  router.get("/", async (context) => {
    const identity = context.get("identity");
    if (identity.kind !== "owner") throw new RequestError("unauthorized");
    const after = context.req.query("after");
    if (after !== undefined && !registeredWorkspaceSchema.shape.id.safeParse(after).success)
      throw new RequestError("invalid_request");
    return context.json(
      await database.transaction(identity.ownerId, ({ workspaces }) => workspaces.list(after)),
    );
  });
  return router;
}
