import type { DbOrTx } from "@winston/db/client";
import { newFrameId, type GatewayToVmFrame } from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
  connectHandoff,
  reconnectHandoff,
  resolveHandoffs,
} from "@winston/db/handoffs";
import { handoffs as handoffRows, runs, vms } from "@winston/db/schema";
import { recordSystemEvent } from "@winston/db/system-events";
import { resumeTask } from "@winston/db/tasks";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { Connections } from "./connections.ts";
import { createVmApi } from "@winston/vm-api";
import type { ConnectorDeps } from "@winston/vm-api/connections";
import type { Jev } from "@winston/vm-api/jev";
import { createExecs, VmUnavailableError } from "./execs.ts";
import { createFileTransfers } from "./files.ts";
import { createHandoffs, viewerCloseCodes, type Viewer } from "./handoffs.ts";
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

/** A live-view page's socket: it signs in with its first message. */
export interface ViewerSocketData {
  kind: "viewer";
  viewer?: Viewer;
  /** The full-desktop fallback's socket (noVNC), not the tab's live view. */
  desktop?: boolean;
  authTimer?: Timer;
}

export type GatewaySocketData = VmSocketData | ViewerSocketData;

type VmSocket = ServerWebSocket<VmSocketData>;
type GatewaySocket = ServerWebSocket<GatewaySocketData>;

const isViewer = (ws: GatewaySocket): ws is ServerWebSocket<ViewerSocketData> =>
  "kind" in ws.data;

/** How the live-view page signs in: its link's token, or its reconnect secret. */
const viewerAuth = z.union([
  z.object({ type: z.literal("auth"), token: z.string().min(1).max(200) }),
  z.object({
    type: z.literal("auth"),
    handoff: z.string().min(1).max(64),
    secret: z.string().min(1).max(200),
    /** The full desktop: only with the secret, i.e. once the link is open. */
    desktop: z.literal(true).optional(),
  }),
]);

/** The live view's Done: `{ "type": "done" }`. */
const isDone = (text: string) => {
  try {
    return (JSON.parse(text) as { type?: unknown }).type === "done";
  } catch {
    return false;
  }
};

/** Close codes for a link that can't be opened (docs/design.md §5). */
const refusals = {
  unknown: [4003, "This link isn't valid."],
  used: [4003, "This link has already been opened."],
  expired: [4004, "This link expired. Ask Winston for a new one."],
  ended: [viewerCloseCodes.ended, "This handoff is over."],
} as const;

const refuse = (
  ws: ServerWebSocket<ViewerSocketData>,
  why: keyof typeof refusals,
) => {
  const [code, reason] = refusals[why];
  ws.close(code, reason);
};

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
  selfUrl,
  jev,
}: {
  db: DbOrTx;
  logger: Logger;
  /**
   * This gateway's own internal address, recorded on a VM while it holds the
   * VM's websocket, so agents calls this gateway for that VM (§15).
   */
  selfUrl?: string;
  internalSecret: string;
  /** Verifies the run tokens CLI calls carry (agents signs them). */
  runTokenSecret: string;
  /** Where published VM binaries come from (production); none locally. */
  artifacts?: Pick<UpdatesOptions, "loadManifest" | "presign">;
  /** Mail and calendar providers for the VM-facing API. */
  connectors?: ConnectorDeps;
  /** Jev for `winston browser autopilot` (§5); absent without a key. */
  jev?: Jev;
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
  const handoffs = createHandoffs({
    send: (vmId, frame) => sendTo(vmId, frame) !== undefined,
    sendBinary: (vmId, message) => {
      const ws = connections.get(vmId);
      ws?.send(message);
      return ws !== undefined;
    },
    logger,
  });
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
    jev,
    ...(connectors ? { connectors } : {}),
    ...(connectors
      ? {
          browser: {
            webPublicUrl: connectors.webPublicUrl,
            hold: async (userId: string, owner: string) =>
              handoffs.hold(await vmIdOf(userId), owner),
            release: (userId: string, owner: string) => {
              void vmIdOf(userId)
                .then((vmId) => {
                  handoffs.release(vmId, owner);
                })
                .catch(() => undefined);
            },
          },
        }
      : {}),
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
    handoffs,
  });
  const send = (ws: VmSocket, frame: GatewayToVmFrame) =>
    ws.send(JSON.stringify(frame));

  /**
   * The person tapped Done on the live view: the browser goes back to
   * Winston. A parked task carries on, as when they say "done" in chat; the
   * front of house hears it as an event and carries on itself. Either way
   * the window is released and the page told it's over.
   */
  async function handBack(viewer: Viewer) {
    const [row] = await db
      .select({ runId: handoffRows.runId, userId: handoffRows.userId })
      .from(handoffRows)
      .where(eq(handoffRows.id, viewer.handoffId));
    const [run] = row
      ? await db
          .select({ kind: runs.kind, status: runs.status })
          .from(runs)
          .where(eq(runs.id, row.runId))
      : [];
    if (!row || !run) return;
    if (run.kind === "background") {
      if (run.status === "parked")
        await resumeTask(db, row.runId, "They tapped Done on the live view.");
    } else {
      await resolveHandoffs(db, row.runId);
      await recordSystemEvent(db, {
        userId: row.userId,
        type: "system.handoff.done",
        payload: { handoffId: viewer.handoffId },
        sourceRef: `handoff:${viewer.handoffId}:done`,
      });
    }
    logger.info(
      { handoffId: viewer.handoffId },
      "handed back from the live view",
    );
    handoffs.release(viewer.vmId, viewer.owner);
  }

  /** Signs a live-view page in and starts its stream, or closes it saying why. */
  async function admitViewer(
    ws: ServerWebSocket<ViewerSocketData>,
    text: string,
  ) {
    clearTimeout(ws.data.authTimer);
    let auth: z.infer<typeof viewerAuth>;
    try {
      auth = viewerAuth.parse(JSON.parse(text));
    } catch {
      refuse(ws, "unknown");
      return;
    }
    let row;
    let viewerSecret: string | undefined;
    if ("token" in auth) {
      const result = await connectHandoff(db, auth.token);
      if (!result.ok) {
        refuse(ws, result.reason);
        return;
      }
      row = result.handoff;
      viewerSecret = result.viewerSecret;
    } else {
      row = await reconnectHandoff(db, auth.handoff, auth.secret);
      if (!row) {
        refuse(ws, "used");
        return;
      }
    }
    const [vm] = await db
      .select({ id: vms.id })
      .from(vms)
      .where(eq(vms.userId, row.userId));
    const [run] = await db
      .select({ kind: runs.kind })
      .from(runs)
      .where(eq(runs.id, row.runId));
    if (!vm || !run) {
      refuse(ws, "ended");
      return;
    }
    const viewer: Viewer = {
      handoffId: row.id,
      vmId: vm.id,
      // winstond names the front of house's windows `front`, others by run id.
      owner: run.kind === "front" ? "front" : row.runId,
      targetId: row.targetId,
      socket: ws,
    };
    ws.data.viewer = viewer;
    if ("desktop" in auth && auth.desktop) {
      ws.data.desktop = true;
      handoffs.openDesktop(viewer);
      return;
    }
    // The page keeps this to reconnect; the link itself is used up.
    if (viewerSecret)
      ws.send(
        JSON.stringify({
          type: "session",
          handoff: row.id,
          secret: viewerSecret,
        }),
      );
    handoffs.connect(viewer);
  }
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

  const websocket: WebSocketHandler<GatewaySocketData> = {
    maxPayloadLength: maxFrameBytes,
    // VMs ping every 20 s; a socket silent for a minute is gone.
    idleTimeout: 60,
    async open(socket) {
      if (isViewer(socket)) {
        // A page that doesn't sign in within 10 s is dropped.
        socket.data.authTimer = setTimeout(() => {
          refuse(socket, "unknown");
        }, 10_000);
        return;
      }
      const ws = socket as VmSocket;
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
      if (selfUrl)
        await db
          .update(vms)
          .set({ gatewayUrl: selfUrl })
          .where(eq(vms.id, vmId));
      logger.info({ vmId }, "VM connected");
    },
    async message(socket, message) {
      if (isViewer(socket)) {
        if (socket.data.desktop && socket.data.viewer) {
          if (typeof message !== "string")
            handoffs.desktopInput(socket.data.viewer, new Uint8Array(message));
          return;
        }
        if (typeof message !== "string") return;
        if (!socket.data.viewer) await admitViewer(socket, message);
        else if (isDone(message)) await handBack(socket.data.viewer);
        else handoffs.input(socket.data.viewer, message);
        return;
      }
      const ws = socket as VmSocket;
      if (typeof message !== "string") {
        // Binary from a VM is a screencast frame for a live view.
        handoffs.frame(ws.data.vmId, new Uint8Array(message));
        return;
      }
      const vmLogger = logger.child({ vmId: ws.data.vmId });
      for (const reply of await handleVmFrame(
        { db, logger: vmLogger, execs, files, vmApi, updates, handoffs },
        ws.data,
        message,
      ))
        send(ws, reply);
    },
    close(socket, code) {
      if (isViewer(socket)) {
        clearTimeout(socket.data.authTimer);
        if (socket.data.viewer && socket.data.desktop)
          handoffs.desktopDisconnected(socket.data.viewer);
        else if (socket.data.viewer) handoffs.disconnected(socket.data.viewer);
        return;
      }
      const ws = socket as VmSocket;
      connections.remove(ws.data.vmId, ws);
      handoffs.vmClosed(ws.data.vmId);
      // Not here any more, unless another gateway has taken it meanwhile.
      if (selfUrl && !connections.get(ws.data.vmId))
        void db
          .update(vms)
          .set({ gatewayUrl: null })
          .where(and(eq(vms.id, ws.data.vmId), eq(vms.gatewayUrl, selfUrl)))
          .catch(() => undefined);
      if (!connections.get(ws.data.vmId)) updates.disconnected(ws.data.vmId);
      files.closed(ws);
      execs.closed(ws.data.vmId);
      logger.info({ vmId: ws.data.vmId, code }, "VM disconnected");
    },
  };

  return {
    updates,
    connections,
    execs,
    files,
    websocket,
    handoffs,
    fetch: async (request: Request, server: Server<GatewaySocketData>) => {
      const url = new URL(request.url);
      // The handoff page's live view; it signs in over the socket.
      if (url.pathname === "/handoff/connect")
        return server.upgrade(request, {
          data: { kind: "viewer" } satisfies ViewerSocketData,
        })
          ? undefined
          : new Response("expected a websocket", { status: 400 });
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
