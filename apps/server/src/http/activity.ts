import { Hono } from "hono";
import { TaskWriteError, type OwnerTransaction } from "@winston/adapters/database";
import {
  taskActivityCursorSchema,
  taskSchema,
  taskHistoryCursorSchema,
  ownerTaskCancelSchema,
  type TaskActivityCursor,
} from "@winston/contracts/tasks";
import type { HttpEnvironment } from "./app";
import { parseJson, RequestError } from "./errors";

export function createActivityOwnerRouter(database: {
  transaction<T>(
    ownerId: string,
    work: (scope: {
      tasks: Pick<
        OwnerTransaction["tasks"],
        "activity" | "detail" | "activityHistory" | "actionEvidence" | "cancel"
      >;
    }) => Promise<T>,
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
  router.get("/:id", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const parsed = taskSchema.shape.id.safeParse(context.req.param("id"));
    if (!parsed.success) throw new RequestError("not_found");
    const value = await database.transaction(owner.ownerId, ({ tasks }) =>
      tasks.detail(parsed.data),
    );
    if (!value) throw new RequestError("not_found");
    return context.json(value);
  });
  router.get("/:id/history", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const parsed = taskSchema.shape.id.safeParse(context.req.param("id"));
    if (!parsed.success) throw new RequestError("not_found");
    const raw = context.req.query("beforeRevision");
    let before: number | undefined;
    if (raw !== undefined) {
      if (!/^(0|[1-9]\d*)$/.test(raw)) throw new RequestError("invalid_request");
      const cursor = taskHistoryCursorSchema.safeParse(Number(raw));
      if (!cursor.success) throw new RequestError("invalid_request");
      before = cursor.data;
    }
    return context.json(
      await database.transaction(owner.ownerId, async ({ tasks }) => {
        if (!(await tasks.detail(parsed.data))) throw new RequestError("not_found");
        return tasks.activityHistory(parsed.data, before);
      }),
    );
  });
  router.get("/:id/actions", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const parsed = taskSchema.shape.id.safeParse(context.req.param("id"));
    if (!parsed.success) throw new RequestError("not_found");
    const after = context.req.query("after");
    if (after !== undefined && !taskSchema.shape.id.safeParse(after).success)
      throw new RequestError("invalid_request");
    return context.json(
      await database.transaction(owner.ownerId, async ({ tasks }) => {
        if (!(await tasks.detail(parsed.data))) throw new RequestError("not_found");
        return tasks.actionEvidence(parsed.data, after);
      }),
    );
  });
  router.post("/:id/cancel", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const parsed = taskSchema.shape.id.safeParse(context.req.param("id"));
    if (!parsed.success) throw new RequestError("not_found");
    const input = await parseJson(context, ownerTaskCancelSchema);
    try {
      const result = await database.transaction(owner.ownerId, async ({ tasks }) => {
        await tasks.cancel(parsed.data, input.revision);
        const detail = await tasks.detail(parsed.data);
        if (!detail) throw new RequestError("not_found");
        return detail;
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof TaskWriteError) throw new RequestError(error.kind);
      throw error;
    }
  });
  return router;
}
