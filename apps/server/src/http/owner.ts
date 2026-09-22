import { Hono } from "hono";
import { timezoneUpdateSchema } from "@winston/contracts/timezone";
import type { OwnerTransaction } from "@winston/adapters/database";
import type { HttpEnvironment } from "./app";
import { parseJson, RequestError } from "./errors";

type Database = {
  transaction<Result>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "ownerId" | "owners">) => Promise<Result>,
  ): Promise<Result>;
};

export function createOwnerRouter(database: Database) {
  const router = new Hono<HttpEnvironment>();

  router.get("/session", (context) => {
    const identity = context.get("identity");

    return context.json(
      identity.kind === "owner" ? { kind: identity.kind, ownerId: identity.ownerId } : null,
    );
  });
  router.get("/timezone", async (context) => {
    const identity = context.get("identity");

    if (identity.kind !== "owner") {
      throw new RequestError("forbidden");
    }

    return context.json(
      await database.transaction(identity.ownerId, (scope) => scope.owners.timezone()),
    );
  });
  router.put("/timezone", async (context) => {
    const identity = context.get("identity");

    if (identity.kind !== "owner") {
      throw new RequestError("forbidden");
    }

    const input = await parseJson(context, timezoneUpdateSchema);
    const result = await database.transaction(identity.ownerId, (scope) =>
      scope.owners.updateTimezone(input.timezone, input.revision),
    );

    return context.json(result.profile, result.conflict ? 409 : 200);
  });

  return router;
}
