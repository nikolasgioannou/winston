import { Hono } from "hono";
import type { createDatabase } from "@winston/adapters/database";
import type { GoogleConnections } from "@winston/adapters/google";
import { handoffSchema } from "@winston/contracts/handoffs";
import type { HttpEnvironment } from "./app";
import { RequestError } from "./errors";

export function createHandoffOwnerRouter(
  database: ReturnType<typeof createDatabase>,
  connections: Pick<GoogleConnections, "startHandoff">,
) {
  const router = new Hono<HttpEnvironment>();
  router.use("/:id/*", async (context, next) => {
    if (!handoffSchema.shape.id.safeParse(context.req.param("id")).success)
      throw new RequestError("invalid_request");
    await next();
  });
  router.get("/:id", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = handoffSchema.shape.id.safeParse(context.req.param("id"));
    if (!id.success) throw new RequestError("invalid_request");
    const handoff = await database.transaction(owner.ownerId, ({ handoffs }) =>
      handoffs.find(id.data),
    );
    if (!handoff) throw new RequestError("not_found");
    return context.json(handoff);
  });
  for (const operation of ["renew", "abandon"] as const)
    router.post(`/:id/${operation}`, async (context) => {
      const owner = context.get("identity");
      if (owner.kind !== "owner") throw new RequestError("unauthorized");
      const handoff = await database.transaction(owner.ownerId, ({ handoffs }) =>
        handoffs[operation](context.req.param("id")),
      );
      if (!handoff) throw new RequestError("not_found");
      return context.json(handoff);
    });
  router.post("/:id/connect", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner" || !owner.sessionId) throw new RequestError("unauthorized");
    const result = await connections.startHandoff(
      owner.ownerId,
      owner.sessionId,
      context.req.param("id"),
    );
    if (!result) throw new RequestError("not_found");
    return context.json(result);
  });
  return router;
}
