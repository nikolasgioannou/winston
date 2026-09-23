import { Hono } from "hono";
import { z } from "zod";
import { ScheduleWriteError, type OwnerTransaction } from "@winston/adapters/database";
import { ScheduleEvaluationError } from "@winston/adapters/schedules";
import {
  ownerScheduleCreateSchema,
  ownerScheduleUpdateSchema,
  ownerScheduleCancelSchema,
} from "@winston/contracts/schedules";
import type { HttpEnvironment } from "./app";
import { parseJson, RequestError } from "./errors";

export function createScheduleOwnerRouter(database: {
  transaction<T>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "schedules">) => Promise<T>,
  ): Promise<T>;
}) {
  const router = new Hono<HttpEnvironment>();
  async function transact<T>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "schedules">) => Promise<T>,
  ) {
    try {
      return await database.transaction(ownerId, work);
    } catch (error) {
      if (error instanceof ScheduleWriteError) throw new RequestError(error.kind);
      if (error instanceof ScheduleEvaluationError) throw new RequestError("invalid_request");
      throw error;
    }
  }
  function identifier(value: string) {
    const result = z.uuid().safeParse(value);
    if (!result.success) throw new RequestError("not_found");
    return result.data;
  }
  router.get("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const after = context.req.query("after");
    if (after !== undefined && !z.uuid().safeParse(after).success)
      throw new RequestError("invalid_request");
    const items = await transact(owner.ownerId, (scope) => scope.schedules.list(after));
    return context.json({ items, next: items.length === 100 ? items.at(-1)?.id : null });
  });
  router.get("/:id", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = identifier(context.req.param("id"));
    const result = await transact(owner.ownerId, (scope) => scope.schedules.find(id));
    if (!result) throw new RequestError("not_found");
    return context.json(result);
  });
  router.post("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const input = await parseJson(context, ownerScheduleCreateSchema);
    const result = await transact(owner.ownerId, (scope) =>
      scope.schedules.create({ ...input, key: `web:${input.key}`, sourceMessageIds: [] }),
    );
    return context.json(result);
  });
  router.put("/:id", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = identifier(context.req.param("id"));
    const input = await parseJson(context, ownerScheduleUpdateSchema);
    const result = await transact(owner.ownerId, async (scope) => {
      const current = await scope.schedules.find(id);
      if (!current) throw new RequestError("not_found");
      return scope.schedules.update(id, input.revision, {
        objective: input.objective,
        timing: input.timing,
        sourceMessageIds: current.sourceMessageIds,
      });
    });
    return context.json(result);
  });
  router.post("/:id/cancel", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = identifier(context.req.param("id"));
    const input = await parseJson(context, ownerScheduleCancelSchema);
    return context.json(
      await transact(owner.ownerId, (scope) => scope.schedules.cancel(id, input.revision)),
    );
  });
  return router;
}
