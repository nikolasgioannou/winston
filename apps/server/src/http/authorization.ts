import { Hono } from "hono";
import type { OwnerTransaction } from "@winston/adapters/database";
import {
  authorizationRequestSchema,
  authorizationUpdateSchema,
} from "@winston/contracts/authorization";
import type { HttpEnvironment } from "./app";
import { parseJson, RequestError } from "./errors";

type Store = {
  transaction<Result>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "authorization">) => Promise<Result>,
  ): Promise<Result>;
};

export function createAuthorizationOwnerRouter(database: Store) {
  const router = new Hono<HttpEnvironment>();
  router.get("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    return context.json(
      await database.transaction(owner.ownerId, ({ authorization }) => authorization.list()),
    );
  });
  router.put("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const input = await parseJson(context, authorizationUpdateSchema);
    const updated = await database.transaction(owner.ownerId, ({ authorization }) =>
      authorization.put(input),
    );
    if (!updated) throw new RequestError("conflict");
    return context.json(updated);
  });
  router.post("/evaluate", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const input = await parseJson(context, authorizationRequestSchema);
    return context.json(
      await database.transaction(owner.ownerId, ({ authorization }) =>
        authorization.evaluate(input),
      ),
    );
  });
  return router;
}
