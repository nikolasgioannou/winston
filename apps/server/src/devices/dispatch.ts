import { DeviceReservationError, type OwnerTransaction } from "@winston/adapters/database";
import type { DeviceSessionIdentity } from "@winston/contracts/device-registry";
import { deviceMessageSchema, encodeDeviceMessage } from "@winston/contracts/devices";

export type DeviceDispatchScope = {
  deviceSessions: Pick<OwnerTransaction["deviceSessions"], "route">;
  deviceExecutions: Pick<OwnerTransaction["deviceExecutions"], "reserve" | "reserveApproved">;
};
type Proof = Parameters<DeviceDispatchScope["deviceExecutions"]["reserve"]>[0];
type PreparedProof = Parameters<DeviceDispatchScope["deviceExecutions"]["reserveApproved"]>[0];
type Channel = {
  isOpen(): boolean;
  send(frame: string): number;
  close(): void;
};
type Database = {
  transaction<Result>(
    ownerId: string,
    work: (scope: DeviceDispatchScope) => Promise<Result>,
  ): Promise<Result>;
};

export function createDeviceDispatcher(
  database: Database,
  options: {
    serverId: string;
    channel(ownerId: string, session: DeviceSessionIdentity): Channel | null;
  },
) {
  return async (ownerId: string, proof: Proof | PreparedProof) => {
    const message = deviceMessageSchema.parse(proof.message);
    if (message.payload.kind !== "execute") return { status: "denied" as const };
    const frame = encodeDeviceMessage(message);
    const session = {
      deviceId: message.deviceId,
      sessionId: message.sessionId,
      generation: message.generation,
    };
    const channel = options.channel(ownerId, session);
    if (!channel?.isOpen()) return { status: "unavailable" as const };
    const reservation = await database
      .transaction(ownerId, async ({ deviceSessions, deviceExecutions }) => {
        const route = await deviceSessions.route(session.deviceId);
        if (
          !route ||
          route.server.serverId !== options.serverId ||
          route.deviceId !== session.deviceId ||
          route.sessionId !== session.sessionId ||
          route.generation !== session.generation
        )
          return { status: "unavailable" as const };
        return "token" in proof
          ? deviceExecutions.reserve({ ...proof, message })
          : deviceExecutions.reserveApproved({ ...proof, message });
      })
      .catch((error: unknown) => {
        if (error instanceof DeviceReservationError) return { status: error.status };
        throw error;
      });
    if (reservation.status !== "reserved") return reservation;

    // The transaction has committed. This is the single send grant, not evidence
    // of completion. Never send again for an existing reservation or failed send.
    try {
      if (channel.isOpen() && channel.send(frame) > 0)
        return { status: "sent" as const, execution: reservation.execution };
    } catch {
      // The peer may have received the frame before the transport failed.
    }
    channel.close();
    return { status: "uncertain" as const, execution: reservation.execution };
  };
}
