import { Hono } from "hono";
import type { createDatabase, OwnerTransaction } from "@winston/adapters/database";
import {
  devicePairingStartSchema,
  deviceRegistrationSchema,
  deviceRenameSchema,
  deviceRevisionSchema,
  registeredDeviceSchema,
} from "@winston/contracts/device-registry";
import type { HttpEnvironment, Identity } from "./app";
import { parseJson, RequestError } from "./errors";

type Database = Pick<
  ReturnType<typeof createDatabase>,
  "authenticateDevice" | "authenticateDevicePairing"
> & {
  transaction<Result>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "devices">) => Promise<Result>,
  ): Promise<Result>;
};

function bearer(request: Request) {
  return request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
}

function deviceId(value: string) {
  const parsed = registeredDeviceSchema.shape.id.safeParse(value);
  if (!parsed.success) throw new RequestError("invalid_request");
  return parsed.data;
}

export function createDeviceOwnerRouter(database: Database) {
  const router = new Hono<HttpEnvironment>();
  router.get("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    return context.json(await database.transaction(owner.ownerId, ({ devices }) => devices.list()));
  });
  router.post("/pairing", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const input = await parseJson(context, devicePairingStartSchema);
    return context.json(
      await database.transaction(owner.ownerId, ({ devices }) => devices.start(input.name)),
    );
  });
  router.delete("/pairing/:id", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = deviceId(context.req.param("id"));
    await database.transaction(owner.ownerId, ({ devices }) => devices.cancelPairing(id));
    return context.body(null, 204);
  });
  router.patch("/:id", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = deviceId(context.req.param("id"));
    const input = await parseJson(context, deviceRenameSchema);
    const result = await database.transaction(owner.ownerId, ({ devices }) =>
      devices.rename(id, input.revision, input.name),
    );
    if (!result) throw new RequestError("conflict");
    return context.json(result);
  });
  for (const action of ["default", "revoke"] as const) {
    router.post(`/:id/${action}`, async (context) => {
      const owner = context.get("identity");
      if (owner.kind !== "owner") throw new RequestError("unauthorized");
      const id = deviceId(context.req.param("id"));
      const input = await parseJson(context, deviceRevisionSchema);
      const result = await database.transaction(owner.ownerId, ({ devices }) =>
        action === "default"
          ? devices.setDefault(id, input.revision)
          : devices.revoke(id, input.revision),
      );
      if (!result) throw new RequestError("conflict");
      return context.json(result);
    });
  }
  return router;
}

export function createDevicePairingRouter(database: Database) {
  const router = new Hono<HttpEnvironment>();
  router.post("/devices/pair", async (context) => {
    const identity = context.get("identity");
    if (identity.kind !== "callback" || identity.provider !== "device-pairing" || !identity.ownerId)
      throw new RequestError("unauthorized");
    const input = await parseJson(context, deviceRegistrationSchema);
    const result = await database.transaction(identity.ownerId, ({ devices }) =>
      devices.pair(bearer(context.req.raw), input),
    );
    if (!result) throw new RequestError("unauthorized");
    return context.json(result, 201);
  });
  return router;
}

export async function authenticateDevicePairing(
  database: Database,
  request: Request,
): Promise<Identity | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/callbacks/devices/pair")
    return null;
  const identity = await database.authenticateDevicePairing(bearer(request));
  return identity
    ? { kind: "callback", provider: "device-pairing", ownerId: identity.ownerId }
    : null;
}

export function createDeviceGroup(database: Database) {
  const router = new Hono<HttpEnvironment>();
  router.get("/self", async (context) => {
    const identity = context.get("identity");
    if (identity.kind !== "device") throw new RequestError("unauthorized");
    const device = await database.transaction(identity.ownerId, ({ devices }) =>
      devices.find(identity.deviceId),
    );
    if (!device || device.revoked) throw new RequestError("unauthorized");
    return context.json(device);
  });
  return {
    router,
    async authenticate(request: Request): Promise<Identity | null> {
      const identity = await database.authenticateDevice(bearer(request));
      return identity ? { kind: "device", ...identity } : null;
    },
  };
}
