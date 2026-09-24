import { Hono } from "hono";
import type { OwnerTransaction } from "@winston/adapters/database";
import { devicePresenceListSchema } from "@winston/contracts/device-registry";
import type { HttpEnvironment } from "./app";
import { RequestError } from "./errors";

type Database = {
  transaction<Result>(
    ownerId: string,
    work: (scope: {
      deviceSessions: Pick<OwnerTransaction["deviceSessions"], "presence">;
    }) => Promise<Result>,
  ): Promise<Result>;
};

export function createDevicePresenceRouter(database: Database) {
  const router = new Hono<HttpEnvironment>();
  router.get("/", async (context) => {
    const identity = context.get("identity");
    if (identity.kind !== "owner") throw new RequestError("unauthorized");
    const presence = await database.transaction(identity.ownerId, ({ deviceSessions }) =>
      deviceSessions.presence(),
    );
    return context.json(devicePresenceListSchema.parse(presence));
  });
  return router;
}
