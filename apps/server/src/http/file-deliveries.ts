import { Hono } from "hono";
import { z } from "zod";
import type { createDeliveryDownloadService } from "@winston/adapters/artifacts";
import type { HttpEnvironment } from "./app";
import { RequestError } from "./errors";

export function createFileDeliveryOwnerRouter(
  service: ReturnType<typeof createDeliveryDownloadService>,
) {
  const router = new Hono<HttpEnvironment>();
  router.get("/:id", async (context) => {
    const identity = context.get("identity");
    if (identity.kind !== "owner") throw new RequestError("unauthorized");
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!id.success) throw new RequestError("not_found");
    return context.json(await service.inspect(identity.ownerId, id.data));
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
  return router;
}
