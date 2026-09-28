import type { DbOrTx } from "@winston/db/client";
import { newFrameId, type GatewayToVmFrame } from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { Connections } from "./connections.ts";
import { createVmApi } from "@winston/vm-api";
import { createExecs } from "./execs.ts";
import { createFileTransfers } from "./files.ts";
import { internalRoutes } from "./internal.ts";
import {
  authenticateVm,
  handleVmFrame,
  register,
  registrationUsedCloseCode,
  type VmSocketData,
} from "./vm-socket.ts";

/** Frames are small today; file transfers will chunk within this. */
export const maxFrameBytes = 1024 * 1024;

type VmSocket = ServerWebSocket<VmSocketData>;

/**
 * The gateway (docs/design.md §9, §15): VMs connect at `/vm/connect`, and
 * everything under `/internal` is the internal API. One `Bun.serve` hosts
 * both.
 */
export function createGateway({
  db,
  logger,
  internalSecret,
  runTokenSecret,
}: {
  db: DbOrTx;
  logger: Logger;
  internalSecret: string;
  /** Verifies the run tokens CLI calls carry (agents signs them). */
  runTokenSecret: string;
}) {
  const vmApi = createVmApi({ db, runTokenSecret });
  const connections = new Connections<VmSocket>();
  /** Sends a frame to a VM's live connection; returns that socket, or undefined if it isn't connected. */
  const sendTo = (vmId: string, frame: GatewayToVmFrame) => {
    const ws = connections.get(vmId);
    ws?.send(JSON.stringify(frame));
    return ws;
  };
  const execs = createExecs((vmId, frame) => sendTo(vmId, frame) !== undefined);
  const files = createFileTransfers(sendTo);
  const internal = internalRoutes({
    db,
    secret: internalSecret,
    isConnected: (vmId) => connections.get(vmId) !== undefined,
    execs,
    files,
  });
  const send = (ws: VmSocket, frame: GatewayToVmFrame) =>
    ws.send(JSON.stringify(frame));

  const websocket: WebSocketHandler<VmSocketData> = {
    maxPayloadLength: maxFrameBytes,
    // VMs ping every 20 s; a socket silent for a minute is gone.
    idleTimeout: 60,
    async open(ws) {
      const { vmId, registrationHash } = ws.data;
      if (registrationHash) {
        const vmToken = await register(db, vmId, registrationHash);
        if (!vmToken) {
          ws.close(
            registrationUsedCloseCode,
            "registration token already used",
          );
          return;
        }
        send(ws, { id: newFrameId(), type: "registered", vmToken });
        logger.info({ vmId }, "VM registered");
      }
      connections.add(vmId, ws);
      logger.info({ vmId }, "VM connected");
      execs.reconnected(vmId);
    },
    async message(ws, message) {
      if (typeof message !== "string") {
        send(ws, {
          id: newFrameId(),
          type: "error",
          code: "unsupported",
          message: "binary frames aren't supported yet",
        });
        return;
      }
      const vmLogger = logger.child({ vmId: ws.data.vmId });
      for (const reply of await handleVmFrame(
        { db, logger: vmLogger, execs, files, vmApi },
        ws.data,
        message,
      ))
        send(ws, reply);
    },
    close(ws, code) {
      connections.remove(ws.data.vmId, ws);
      files.closed(ws);
      logger.info({ vmId: ws.data.vmId, code }, "VM disconnected");
    },
  };

  return {
    connections,
    execs,
    files,
    websocket,
    fetch: async (request: Request, server: Server<VmSocketData>) => {
      const url = new URL(request.url);
      if (url.pathname === "/vm/connect") {
        const data = await authenticateVm(
          db,
          request.headers.get("Authorization"),
        );
        if (!data) return new Response("unauthorized", { status: 401 });
        return server.upgrade(request, { data })
          ? undefined
          : new Response("expected a websocket", { status: 400 });
      }
      if (url.pathname.startsWith("/internal/")) return internal.fetch(request);
      return new Response("not found", { status: 404 });
    },
  };
}
