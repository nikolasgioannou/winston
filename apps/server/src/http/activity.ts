import { Hono } from "hono";
import type { OwnerTransaction } from "@winston/adapters/database";
import { taskActivityCursorSchema, type TaskActivityCursor } from "@winston/contracts/tasks";
import type { HttpEnvironment } from "./app";
import { RequestError } from "./errors";

export function createActivityOwnerRouter(database: {
  transaction<T>(
    ownerId: string,
    work: (scope: { tasks: Pick<OwnerTransaction["tasks"], "activity"> }) => Promise<T>,
  ): Promise<T>;
}) {
  const router = new Hono<HttpEnvironment>();
  router.get("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const createdAt = context.req.query("beforeCreatedAt");
    const id = context.req.query("beforeId");
    let before: TaskActivityCursor | undefined;
    if (createdAt !== undefined || id !== undefined) {
      const parsed = taskActivityCursorSchema.safeParse({ createdAt, id });
      if (!parsed.success) throw new RequestError("invalid_request");
      before = parsed.data;
    }
    return context.json(
      await database.transaction(owner.ownerId, ({ tasks }) => tasks.activity(before)),
    );
  });
  return router;
}
