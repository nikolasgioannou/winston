import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { createDatabase, OwnerTransaction } from "@winston/adapters/database";
import {
  deviceSessionWelcomeSchema,
  type DeviceSessionIdentity,
} from "@winston/contracts/device-registry";
import {
  decodeDeviceMessage,
  deviceFrameLimit,
  encodeDeviceMessage,
} from "@winston/contracts/devices";
import { errorResponse } from "../http/errors";

type Database = Pick<ReturnType<typeof createDatabase>, "authenticateDevice"> & {
  transaction<Result>(
    ownerId: string,
    work: (scope: Pick<OwnerTransaction, "deviceSessions">) => Promise<Result>,
  ): Promise<Result>;
};

export type DeviceSocketData = {
  ownerId: string;
  session: DeviceSessionIdentity;
  expiresAt: string;
  busy: boolean;
  closed: boolean;
  timeout?: ReturnType<typeof setTimeout>;
};

export function createDeviceSocketTransport(database: Database) {
  const sockets = new Set<ServerWebSocket<DeviceSocketData>>();
  const cleanups = new Set<Promise<void>>();
  const lifetime = new AbortController();
  const isStopped = () => lifetime.signal.aborted;
  const isClosed = (socket: ServerWebSocket<DeviceSocketData>) => socket.data.closed;

  function cleanup(data: DeviceSocketData) {
    const pending = database
      .transaction(data.ownerId, ({ deviceSessions }) => deviceSessions.close(data.session))
      .then(() => {})
      // A failed cleanup cannot revive the bounded database lease.
      .catch(() => {})
      .finally(() => {
        cleanups.delete(pending);
      });
    cleanups.add(pending);
  }

  function close(socket: ServerWebSocket<DeviceSocketData>, code: number) {
    if (socket.data.closed) return;
    socket.data.closed = true;
    clearTimeout(socket.data.timeout);
    sockets.delete(socket);
    socket.close(code);
    cleanup(socket.data);
  }

  function arm(socket: ServerWebSocket<DeviceSocketData>) {
    clearTimeout(socket.data.timeout);
    socket.data.timeout = setTimeout(() => {
      close(socket, 1008);
    }, 45_000);
  }

  const websocket: WebSocketHandler<DeviceSocketData> = {
    maxPayloadLength: deviceFrameLimit,
    backpressureLimit: deviceFrameLimit,
    closeOnBackpressureLimit: true,
    idleTimeout: 45,
    open(socket) {
      if (isStopped()) {
        close(socket, 1012);
        return;
      }
      sockets.add(socket);
      arm(socket);
      const session = deviceSessionWelcomeSchema.parse({
        kind: "session",
        version: 1,
        ...socket.data.session,
        expiresAt: socket.data.expiresAt,
      });
      if (socket.send(JSON.stringify(session)) <= 0) close(socket, 1013);
    },
    async message(socket, raw) {
      if (isClosed(socket)) return;
      if (socket.data.busy || typeof raw !== "string") {
        close(socket, 1008);
        return;
      }
      socket.data.busy = true;
      try {
        const message = decodeDeviceMessage(raw);
        const session = socket.data.session;
        if (
          message.deviceId !== session.deviceId ||
          message.sessionId !== session.sessionId ||
          message.generation !== session.generation ||
          message.payload.kind !== "heartbeat"
        ) {
          close(socket, 1008);
          return;
        }
        const status = message.payload.status;
        const accepted = await database.transaction(socket.data.ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(session, status),
        );
        if (!accepted) {
          close(socket, 1008);
          return;
        }
        if (isClosed(socket)) return;
        arm(socket);
        const response = encodeDeviceMessage({
          ...message,
          messageId: crypto.randomUUID(),
          correlationId: message.messageId,
        });
        if (socket.send(response) <= 0) close(socket, 1013);
      } catch {
        close(socket, 1008);
      } finally {
        socket.data.busy = false;
      }
    },
    close(socket) {
      close(socket, 1000);
    },
  };

  return {
    websocket,
    async upgrade(request: Request, server: Server<DeviceSocketData>) {
      const error = (code: "unauthorized" | "invalid_request" | "unavailable") =>
        errorResponse(code, crypto.randomUUID());
      if (isStopped()) return error("unavailable");
      if (
        request.method !== "GET" ||
        request.headers.has("Origin") ||
        new URL(request.url).search ||
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
      )
        return error("invalid_request");
      const credential = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
      const identity = await database.authenticateDevice(credential);
      if (!identity) return error("unauthorized");
      const session = await database.transaction(identity.ownerId, ({ deviceSessions }) =>
        deviceSessions.open(identity.deviceId, credential),
      );
      if (!session) return error("unauthorized");
      const data: DeviceSocketData = {
        ownerId: identity.ownerId,
        session: {
          deviceId: session.deviceId,
          sessionId: session.sessionId,
          generation: session.generation,
        },
        expiresAt: session.expiresAt,
        busy: false,
        closed: false,
      };
      if (isStopped() || !server.upgrade(request, { data })) {
        cleanup(data);
        return error("unavailable");
      }
      return undefined;
    },
    async stop() {
      lifetime.abort();
      for (const socket of sockets) close(socket, 1012);
      await Promise.all(cleanups);
    },
  };
}
