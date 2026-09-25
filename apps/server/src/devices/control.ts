import type { OwnerTransaction } from "@winston/adapters/database";
import type { DeviceSessionIdentity } from "@winston/contracts/device-registry";
import { deviceMessageSchema, encodeDeviceMessage } from "@winston/contracts/devices";

export type DeviceControlScope = {
  deviceSessions: Pick<OwnerTransaction["deviceSessions"], "route">;
  deviceExecutions: Pick<OwnerTransaction["deviceExecutions"], "planControls">;
};

type Channel = {
  isOpen(): boolean;
  send(frame: string): number;
  close(): void;
};

type Database = {
  transaction<Result>(
    ownerId: string,
    work: (scope: DeviceControlScope) => Promise<Result>,
  ): Promise<Result>;
};

export function createDeviceControlDelivery(database: Database, serverId: string) {
  return async (ownerId: string, session: DeviceSessionIdentity, channel: Channel) => {
    if (!channel.isOpen()) return;
    const frames = await database.transaction(
      ownerId,
      async ({ deviceSessions, deviceExecutions }) => {
        const route = await deviceSessions.route(session.deviceId);
        if (
          !route ||
          route.server.serverId !== serverId ||
          route.deviceId !== session.deviceId ||
          route.sessionId !== session.sessionId ||
          route.generation !== session.generation
        )
          return [];
        const plan = await deviceExecutions.planControls(session);
        if (plan.length > 6) throw new Error("Device control plan exceeds its bound.");
        return plan.map((input) => {
          const message = deviceMessageSchema.parse(input);
          if (
            !["cancel", "reconcile"].includes(message.payload.kind) ||
            message.deviceId !== session.deviceId ||
            message.sessionId !== session.sessionId ||
            message.generation !== session.generation
          )
            throw new Error("Device control plan has an invalid binding.");
          return encodeDeviceMessage(message);
        });
      },
    );
    // Query identities must be committed before the device can answer them.
    // Cancellation and queries are repeatable; this path can never send execute.
    for (const frame of frames) {
      if (!channel.isOpen()) return;
      try {
        if (channel.send(frame) > 0) continue;
      } catch {
        // A later session will reconcile any uncertain execution.
      }
      channel.close();
      return;
    }
  };
}
