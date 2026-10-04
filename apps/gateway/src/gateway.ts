import type { DbOrTx } from "@winston/db/client";
import type { BrowserPageWindow } from "@winston/domain/browser";
import { newFrameId, type GatewayToVmFrame } from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { openHandoffs, resolveHandoffs } from "@winston/db/handoffs";
import { runs, vms } from "@winston/db/schema";
import { recordSystemEvent } from "@winston/db/system-events";
import { resumeTask } from "@winston/db/tasks";
import { useViewerTicket } from "@winston/db/viewer-tickets";
import { createId } from "@winston/shared/ids";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { Connections } from "./connections.ts";
import { createVmApi } from "@winston/vm-api";
import type { ConnectorDeps } from "@winston/vm-api/connections";
import type { Jev } from "@winston/vm-api/jev";
import type { SiteDeps } from "@winston/vm-api/sites";
import { createExecs, VmUnavailableError } from "./execs.ts";
import { createFileTransfers } from "./files.ts";
import {
  createHandoffs,
  viewerCloseCodes,
  type Viewer,
  type Watched,
} from "./handoffs.ts";
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

/** A browser page's socket: it signs in with its first message. */
export interface ViewerSocketData {
  kind: "viewer";
  viewer?: Viewer;
  /** The full-desktop fallback's socket (noVNC), not a tab's live view. */
  desktop?: boolean;
  authTimer?: Timer;
}

export type GatewaySocketData = VmSocketData | ViewerSocketData;

type VmSocket = ServerWebSocket<VmSocketData>;
type GatewaySocket = ServerWebSocket<GatewaySocketData>;

const isViewer = (ws: GatewaySocket): ws is ServerWebSocket<ViewerSocketData> =>
  "kind" in ws.data;

/** How the browser page signs a socket in: a ticket its own server issued. */
const viewerAuth = z.object({
  type: z.literal("auth"),
  ticket: z.string().min(1).max(200),
  /** The full desktop, for a page with a window in hand. */
  desktop: z.literal(true).optional(),
});

/** What a signed-in page asks; anything else it sends is input for the tab. */
const viewerRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("windows") }),
  z.object({ type: z.literal("watch"), windowId: z.string().min(1).max(64) }),
  /** Take control of the watched window (take it over, if Winston has it). */
  z.object({ type: z.literal("control") }),
  /** Give it back to Winston: Done. */
  z.object({ type: z.literal("done") }),
]);

/**
 * The gateway (docs/design.md §9, §15): VMs connect at `/vm/connect`, the
 * browser page at `/browser/connect` (the only two paths the load balancer
 * routes here, infra/src/services.ts), everything under `/internal` is the
 * internal API, and `/health` is for the load balancer. One `Bun.serve` hosts
 * them all.
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
  sites,
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
  /** Jev and its helpers for `winston browser act` (§5); absent without a key. */
  jev?: Jev;
  /** Where `winston site deploy` puts sites (§9a); absent without a site host. */
  sites?: SiteDeps;
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
    sites,
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
   * The person tapped Done on a window that was handed over: it goes back
   * to Winston. A parked task carries on, as when they say "done" in chat;
   * the front of house hears it as an event and carries on itself. The page
   * keeps watching.
   */
  async function handBack(viewer: Viewer, window: Watched) {
    const handoff = (await openHandoffs(db, viewer.userId)).find(
      (h) => h.windowId === window.windowId,
    );
    const [run] = handoff
      ? await db
          .select({ kind: runs.kind, status: runs.status })
          .from(runs)
          .where(eq(runs.id, handoff.runId))
      : [];
    if (handoff && run?.kind === "background") {
      if (run.status === "parked")
        await resumeTask(
          db,
          handoff.runId,
          "They tapped Done on the browser page.",
        );
    } else if (handoff) {
      await resolveHandoffs(db, handoff.runId);
      await recordSystemEvent(db, {
        userId: viewer.userId,
        type: "system.handoff.done",
        payload: { handoffId: handoff.id },
        sourceRef: `handoff:${handoff.id}:done`,
      });
    }
    logger.info(
      { windowId: window.windowId },
      "handed back from the browser page",
    );
    handoffs.release(viewer.vmId, window.owner, { windowId: window.windowId });
  }

  /** The VM's windows as the page shows them: who they're for, and who has control. */
  async function pageWindows(viewer: Viewer): Promise<BrowserPageWindow[]> {
    const [listed, open] = await Promise.all([
      handoffs.list(viewer.vmId),
      openHandoffs(db, viewer.userId),
    ]);
    const tasks = listed.map((w) => w.owner).filter((o) => o !== "front");
    const briefs = new Map(
      tasks.length > 0
        ? (
            await db
              .select({ id: runs.id, brief: runs.brief })
              .from(runs)
              .where(inArray(runs.id, tasks))
          ).map((r) => [r.id, (r.brief ?? "").slice(0, 120)])
        : [],
    );
    return listed.map((w) => {
      const controller = handoffs.controllerOf(viewer.vmId, w.windowId);
      return {
        id: w.windowId,
        owner: w.owner,
        task: w.owner === "front" ? null : (briefs.get(w.owner) ?? ""),
        title: w.title,
        url: w.url,
        held: w.held,
        reason:
          w.held === "handoff"
            ? (open.find((h) => h.windowId === w.windowId)?.reason ?? null)
            : null,
        control:
          controller === undefined
            ? null
            : controller === viewer.viewId
              ? "you"
              : "elsewhere",
        lastUsedAt: w.lastUsedAt,
      };
    });
  }

  /** The window by id, as the VM has it now. */
  async function windowOn(viewer: Viewer, windowId: string) {
    return (await handoffs.list(viewer.vmId)).find(
      (w) => w.windowId === windowId,
    );
  }

  /** Signs a browser page's socket in with its ticket, or closes it saying why. */
  async function admitViewer(
    ws: ServerWebSocket<ViewerSocketData>,
    text: string,
  ) {
    clearTimeout(ws.data.authTimer);
    let auth: z.infer<typeof viewerAuth>;
    try {
      auth = viewerAuth.parse(JSON.parse(text));
    } catch {
      ws.close(viewerCloseCodes.unauthorized, "Sign in again.");
      return;
    }
    const userId = await useViewerTicket(db, auth.ticket);
    if (!userId) {
      ws.close(viewerCloseCodes.unauthorized, "Sign in again.");
      return;
    }
    const [vm] = await db
      .select({ id: vms.id })
      .from(vms)
      .where(eq(vms.userId, userId));
    if (!vm) {
      ws.close(
        viewerCloseCodes.vmOffline,
        "Winston's computer isn't set up yet.",
      );
      return;
    }
    const viewer: Viewer = {
      viewId: createId("view"),
      userId,
      vmId: vm.id,
      socket: ws,
    };
    ws.data.viewer = viewer;
    if (auth.desktop) {
      // The whole screen: only while the person has a window in hand.
      if (!handoffs.hasControl(vm.id)) {
        ws.close(viewerCloseCodes.unauthorized, "Take over a window first.");
        return;
      }
      ws.data.desktop = true;
      handoffs.openDesktop(viewer);
      return;
    }
    handoffs.join(viewer);
    ws.send(JSON.stringify({ type: "ready" }));
  }

  /** What a signed-in page asked, or its input for the tab. */
  async function viewerMessage(viewer: Viewer, text: string) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const request = viewerRequest.safeParse(data);
    if (!request.success) {
      handoffs.input(viewer, data);
      return;
    }
    const tell = (message: Record<string, unknown>) =>
      viewer.socket.send(JSON.stringify(message));
    try {
      switch (request.data.type) {
        case "windows":
          tell({ type: "windows", windows: await pageWindows(viewer) });
          return;
        case "watch": {
          const window = await windowOn(viewer, request.data.windowId);
          if (!window) {
            tell({
              type: "ended",
              windowId: request.data.windowId,
              reason: "That window is gone.",
            });
            return;
          }
          handoffs.watch(viewer, window);
          // A window the person has, with nobody in control, is this page's.
          if (
            window.held &&
            handoffs.controllerOf(viewer.vmId, window.windowId) === undefined
          )
            handoffs.grant(viewer);
          return;
        }
        case "control": {
          const watched = viewer.watching;
          if (!watched) return;
          const window = await windowOn(viewer, watched.windowId);
          if (!window) return;
          const held =
            window.held ??
            (await handoffs.hold(viewer.vmId, window.owner, {
              windowId: window.windowId,
              takeover: true,
            }));
          if (held) handoffs.grant(viewer);
          return;
        }
        case "done": {
          const watched = viewer.watching;
          if (!watched || !handoffs.controls(viewer)) return;
          const window = await windowOn(viewer, watched.windowId);
          if (window?.held === "handoff") await handBack(viewer, watched);
          else
            handoffs.release(viewer.vmId, watched.owner, {
              windowId: watched.windowId,
            });
          return;
        }
      }
    } catch (error) {
      logger.warn({ err: error }, "a browser page's request failed");
      tell({
        type: "error",
        message: "Winston's computer didn't answer; try again.",
      });
    }
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
          socket.close(viewerCloseCodes.unauthorized, "Sign in again.");
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
        else await viewerMessage(socket.data.viewer, message);
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
      // The browser page's live view; it signs in over the socket.
      if (url.pathname === "/browser/connect")
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
