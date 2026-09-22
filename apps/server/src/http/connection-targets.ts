import { Hono } from "hono";
import type { OwnerTransaction } from "@winston/adapters/database";
import { targetPreferencesSchema } from "@winston/contracts/connection-targets";
import type { HttpEnvironment } from "./app";
import { parseJson, RequestError } from "./errors";

export function createTargetPreferencesRouter(database: {
  transaction<T>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "connectionTargets">) => Promise<T>,
  ): Promise<T>;
}) {
  const router = new Hono<HttpEnvironment>();
  router.get("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    return context.json(
      await database.transaction(owner.ownerId, (scope) => scope.connectionTargets.preferences()),
    );
  });
  router.put("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const input = await parseJson(context, targetPreferencesSchema);
    const result = await database.transaction(owner.ownerId, (scope) =>
      scope.connectionTargets.put(input),
    );
    if (!result) throw new RequestError("conflict");
    return context.json(result);
  });
  return router;
}
