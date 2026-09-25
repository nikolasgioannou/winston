import type { createDatabase, OwnerTransaction } from "@winston/adapters/database";
import { serviceRequestSchema, type ServiceRequest } from "@winston/contracts/capabilities";
import {
  deviceServerIdentitySchema,
  deviceSessionRouteSchema,
  deviceSessionIdentitySchema,
  type DeviceServerIdentity,
} from "@winston/contracts/device-registry";

export type DeviceRoutingScope = {
  capabilities: Pick<OwnerTransaction["capabilities"], "authenticate">;
  deviceSessions: Pick<OwnerTransaction["deviceSessions"], "route">;
};
type Database = Pick<ReturnType<typeof createDatabase>, "authenticateService"> & {
  transaction<Result>(
    ownerId: string,
    work: (scope: DeviceRoutingScope) => Promise<Result>,
  ): Promise<Result>;
};

export function createDeviceRequestRouting(database: Database, inputServer: DeviceServerIdentity) {
  const server = deviceServerIdentitySchema.parse(inputServer);
  return async (input: ServiceRequest, inputDeviceId: string, headers: Headers) => {
    const credential = serviceRequestSchema.parse(input);
    const deviceId = deviceSessionIdentitySchema.shape.deviceId.parse(inputDeviceId);
    const denied = () => ({
      kind: "response" as const,
      response: Response.json({
        version: 1,
        status: "denied",
        message: "Task control authority is unavailable or expired.",
      }),
    });
    const unavailable = (replay?: string) => ({
      kind: "response" as const,
      response: Response.json(
        {
          version: 1,
          status: "unavailable",
          message: "The computer's connection is unavailable. Try again shortly.",
        },
        replay ? { headers: { "fly-replay": replay } } : undefined,
      ),
    });
    if (credential.kind !== "workspace" || credential.operation !== "gateway:control")
      return denied();
    const identity = await database.authenticateService(credential);
    if (!identity) return denied();
    const resolved = await database.transaction(
      identity.ownerId,
      async ({ capabilities, deviceSessions }) => {
        const authority = await capabilities.authenticate(credential);
        if (!authority) return null;
        const route = await deviceSessions.route(deviceId);
        return { authority, route: route ? deviceSessionRouteSchema.parse(route) : null };
      },
    );
    if (!resolved) return denied();
    const { route, authority } = resolved;
    if (!route || route.deviceId !== deviceId || headers.has("fly-replay-failed"))
      return unavailable();
    if (route.server.serverId === server.serverId)
      return {
        kind: "local" as const,
        ownerId: identity.ownerId,
        task: {
          id: authority.taskId,
          revision: authority.revision,
          generation: authority.generation,
        },
        session: { deviceId, sessionId: route.sessionId, generation: route.generation },
      };
    if (
      !server.machineId ||
      !route.server.machineId ||
      route.server.machineId === server.machineId ||
      headers.has("fly-replay-src")
    )
      return unavailable();
    // Fly routes the original authenticated request. No action is claimed here;
    // the destination must authenticate again and reserve before sending once.
    return unavailable(`instance=${route.server.machineId};timeout=2s;fallback=force_self`);
  };
}
