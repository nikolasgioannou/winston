import type { DbOrTx } from "@winston/db/client";
import { newFrameId, type GatewayToVmFrame } from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { vms } from "@winston/db/schema";
import { eq, sql } from "drizzle-orm";
import { Connections } from "./connections.ts";
import { createVmApi } from "@winston/vm-api";
import type { ConnectorDeps } from "@winston/vm-api/connections";
import { createExecs, VmUnavailableError } from "./execs.ts";
import { createFileTransfers } from "./files.ts";
import { internalRoutes } from "./internal.ts";
import { createUpdates, type UpdatesOptions } from "./updates.ts";
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
 * The gateway (docs/design.md §9, §15): VMs connect at `/vm/connect`,
 * everything under `/internal` is the internal API, and `/health` is for the
 * load balancer. One `Bun.serve` hosts them all.
 */
export function createGateway({
  db,
  logger,
  internalSecret,
  runTokenSecret,
  artifacts,
  connectors,
}: {
  db: DbOrTx;
  logger: Logger;
  internalSecret: string;
  /** Verifies the run tokens CLI calls carry (agents signs them). */
  runTokenSecret: string;
  /** Where published VM binaries come from (production); none locally. */
  artifacts?: Pick<UpdatesOptions, "loadManifest" | "presign">;
  /** Mail and calendar providers for the VM-facing API. */
  connectors?: ConnectorDeps;
}) {
  const connections = new Connections<VmSocket>();
  /** Sends a frame to a VM's live connection; returns that socket, or undefined if it isn't connected. */
  const sendTo = (vmId: string, frame: GatewayToVmFrame) => {
    const ws = connections.get(vmId);
    ws?.send(JSON.stringify(frame));
    return ws;
  };
  const execs = createExecs((vmId, frame) => sendTo(vmId, frame) !== undefined);
  const updates = createUpdates({
    loadManifest: artifacts?.loadManifest ?? (() => Promise.resolve(undefined)),
    presign:
      artifacts?.presign ?? (() => Promise.reject(new Error("no artifacts"))),
    send: (vmId, frame) => sendTo(vmId, frame) !== undefined,
    logger,
  });
  const files = createFileTransfers(sendTo);
  const vmIdOf = async (userId: string) => {
    const [vm] = await db
      .select({ id: vms.id })
      .from(vms)
      .where(eq(vms.userId, userId));
    if (!vm) throw new VmUnavailableError();
    return vm.id;
  };
  const vmApi = createVmApi({
    db,
    runTokenSecret,
    ...(connectors ? { connectors } : {}),
    // Attachments travel to and from the user's VM through the file transfer.
    vmFiles: {
      async read(userId, path) {
        return new Uint8Array(
          await new Response(
            await files.read(await vmIdOf(userId), path),
          ).arrayBuffer(),
        );
      },
      async write(userId, path, bytes) {
        return files.write(await vmIdOf(userId), path, bytes);
      },
    },
  });
  const internal = internalRoutes({
    db,
    secret: internalSecret,
    isConnected: (vmId) => connections.get(vmId) !== undefined,
    execs,
    files,
    updates,
  });
  const send = (ws: VmSocket, frame: GatewayToVmFrame) =>
    ws.send(JSON.stringify(frame));
  /** Liveness for the load balancer, like api's: the process answers and Postgres is reachable. */
  const health = async () => {
    try {
      await db.execute(sql`select 1`);
      return Response.json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "health check: database unreachable");
      return Response.json({ ok: false }, { status: 503 });
    }
  };

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
        { db, logger: vmLogger, execs, files, vmApi, updates },
        ws.data,
        message,
      ))
        send(ws, reply);
    },
    close(ws, code) {
      connections.remove(ws.data.vmId, ws);
      if (!connections.get(ws.data.vmId)) updates.disconnected(ws.data.vmId);
      files.closed(ws);
      logger.info({ vmId: ws.data.vmId, code }, "VM disconnected");
    },
  };

  return {
    updates,
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
      if (url.pathname === "/health") return health();
      return new Response("not found", { status: 404 });
    },
  };
}
