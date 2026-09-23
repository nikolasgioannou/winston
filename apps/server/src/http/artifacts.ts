import { Hono } from "hono";
import { z } from "zod";
import type { createArtifactService } from "@winston/adapters/artifacts";
import type { HttpEnvironment } from "./app";
import { RequestError } from "./errors";

export function createArtifactOwnerRouter(
  service: Pick<ReturnType<typeof createArtifactService>, "list" | "download" | "remove">,
) {
  const router = new Hono<HttpEnvironment>();
  router.get("/", async (context) => {
    const identity = context.get("identity");
    if (identity.kind !== "owner") throw new RequestError("unauthorized");
    const after = z.uuid().optional().safeParse(context.req.query("after"));
    if (!after.success) throw new RequestError("invalid_request");
    const records = await service.list(identity.ownerId, after.data);
    return context.json({
      artifacts: records.map(({ id, metadata }) => ({ id, ...metadata })),
      next: records.length === 100 ? records.at(-1)?.id : null,
    });
  });
  router.get("/:id/download", async (context) => {
    const identity = context.get("identity");
    if (identity.kind !== "owner") throw new RequestError("unauthorized");
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!id.success) throw new RequestError("not_found");
    const result = await service.download(identity.ownerId, id.data);
    if (!result) throw new RequestError("not_found");
    return context.json(result);
  });
  router.delete("/:id", async (context) => {
    const identity = context.get("identity");
    if (identity.kind !== "owner") throw new RequestError("unauthorized");
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!id.success) throw new RequestError("not_found");
    const result = await service.remove(identity.ownerId, id.data);
    if (!result) throw new RequestError("conflict");
    return context.json({ id: result.id, state: result.state });
  });
  return router;
}
