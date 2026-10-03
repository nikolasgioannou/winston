/**
 * The browser page's live views, in the gateway (docs/design.md §5, §15):
 * holding and releasing windows on a VM, listing them, and relaying live
 * views between the signed-in browser page and the tab it's watching.
 *
 * Each page socket is a viewer. It watches one window at a time (its own
 * screencast on the VM), and any number can watch the same one: a phone and
 * a laptop. Control of a window is the person's while it's handed over or
 * they've taken it over, and belongs to one viewer at a time, the last to
 * take it; only that viewer's input and size reach the tab. When control
 * goes back to Winston, viewers keep watching.
 */
import {
  desktopMessage,
  newFrameId,
  parseDesktopMessage,
  parseScreencastMessage,
  viewerInput,
  type GatewayToVmFrame,
  type ListedWindow,
  type VmToGatewayFrame,
} from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import { VmUnavailableError, VmUnreachableError } from "./execs.ts";

/** What a viewer socket needs: send to the page, and close it. */
export interface ViewerSocket {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
}

/** A window a viewer is watching: what it needs to stream and control it. */
export interface Watched {
  windowId: string;
  targetId: string;
  /** Whose window it is, as winstond names runs (`front`, or a run id). */
  owner: string;
}

export interface Viewer {
  /** This page's live view on the VM (made by the gateway). */
  viewId: string;
  userId: string;
  vmId: string;
  socket: ViewerSocket;
  watching?: Watched | undefined;
}

/** Close codes the page reads (docs/design.md §5). */
export const viewerCloseCodes = {
  /** The computer isn't connected; the page signs in again and retries. */
  vmOffline: 4001,
  /** The ticket was unknown, used or expired: the page gets a new one. */
  unauthorized: 4003,
} as const;

const askTimeoutMs = 10_000;

export interface HeldWindow {
  windowId: string;
  targetId: string;
  url: string;
}

export function createHandoffs({
  send,
  sendBinary,
  logger,
}: {
  /** Sends a frame to a VM; false if it isn't connected. */
  send: (vmId: string, frame: GatewayToVmFrame) => boolean;
  /** Sends a binary message to a VM; false if it isn't connected. */
  sendBinary: (vmId: string, message: Uint8Array) => boolean;
  logger: Logger;
}) {
  /** Holds, transfers and listings waiting on the VM's answer, by frame id. */
  const asks = new Map<
    string,
    { resolve: (answer: unknown) => void; timer: Timer }
  >();
  const viewers = new Map<string, Viewer>();
  /** Full-desktop fallbacks (noVNC), by view: at most one each. */
  const desktops = new Map<string, Viewer>();
  /** Who controls each window the person has, `vmId:windowId` → viewId. */
  const control = new Map<string, string>();

  const key = (vmId: string, windowId: string) => `${vmId}:${windowId}`;

  /** Tells a page something (a JSON message on its socket). */
  const tell = (viewer: Viewer, message: Record<string, unknown>) => {
    viewer.socket.send(JSON.stringify(message));
  };

  /** Sends a frame the VM answers, and waits for its answer. */
  function ask<T>(vmId: string, frame: (id: string) => GatewayToVmFrame) {
    const id = newFrameId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        asks.delete(id);
        reject(new VmUnreachableError());
      }, askTimeoutMs);
      asks.set(id, {
        resolve: (answer) => {
          resolve(answer as T);
        },
        timer,
      });
      if (!send(vmId, frame(id))) {
        clearTimeout(timer);
        asks.delete(id);
        reject(new VmUnavailableError());
      }
    });
  }

  function closeDesktop(viewId: string, reason: string) {
    const desktop = desktops.get(viewId);
    if (!desktop) return;
    desktops.delete(viewId);
    send(desktop.vmId, { id: newFrameId(), type: "desktop.close", viewId });
    desktop.socket.close(1000, reason);
  }

  /** Stops a viewer's stream (it stopped watching, switched, or went away). */
  function stopWatching(viewer: Viewer) {
    if (!viewer.watching) return;
    send(viewer.vmId, {
      id: newFrameId(),
      type: "screencast.stop",
      viewId: viewer.viewId,
    });
    viewer.watching = undefined;
  }

  /**
   * Control of a window goes (back to Winston, or to another viewer); its
   * holder hears. Its stream starts over: the page's size was emulated in
   * that stream's own session on the VM, and a new session drops it, so the
   * tab is back at Winston's size.
   */
  function dropControl(vmId: string, windowId: string) {
    const holder = control.get(key(vmId, windowId));
    if (!holder) return;
    control.delete(key(vmId, windowId));
    const viewer = viewers.get(holder);
    if (viewer) {
      tell(viewer, { type: "control", windowId, yours: false });
      if (viewer.watching?.windowId === windowId) {
        send(vmId, {
          id: newFrameId(),
          type: "screencast.stop",
          viewId: holder,
        });
        send(vmId, {
          id: newFrameId(),
          type: "screencast.start",
          viewId: holder,
          targetId: viewer.watching.targetId,
        });
      }
    }
    closeDesktop(holder, "Control went back to Winston.");
  }

  const controls = (viewer: Viewer) =>
    viewer.watching !== undefined &&
    control.get(key(viewer.vmId, viewer.watching.windowId)) === viewer.viewId;

  return {
    /** Asks a VM to hold a window for the person: the owner's current one, or that one taken over. */
    hold(
      vmId: string,
      owner: string,
      options: { windowId?: string; takeover?: boolean } = {},
    ): Promise<HeldWindow | null> {
      return ask(vmId, (id) => ({
        id,
        type: "browser.hold",
        owner,
        ...(options.windowId ? { windowId: options.windowId } : {}),
        ...(options.takeover ? { takeover: true } : {}),
      }));
    },

    /** Asks a VM to give a window (`from`'s current one by default) to another run. */
    transfer(
      vmId: string,
      request: { from: string; to: string; windowId?: string | undefined },
    ): Promise<HeldWindow | null> {
      return ask(vmId, (id) => ({
        id,
        type: "browser.transfer",
        from: request.from,
        to: request.to,
        ...(request.windowId ? { windowId: request.windowId } : {}),
      }));
    },

    /** Every open window on a VM. */
    list(vmId: string): Promise<ListedWindow[]> {
      return ask(vmId, (id) => ({ id, type: "browser.list" }));
    },

    /**
     * Gives an owner's windows (or just one) back to Winston: viewers keep
     * watching, and whoever had control hears it's gone. With `close` (the
     * run has ended) its windows close too, and their streams end. False if
     * the VM isn't connected.
     */
    release(
      vmId: string,
      owner: string,
      options: { windowId?: string | undefined; close?: boolean } = {},
    ) {
      for (const viewer of viewers.values())
        if (
          viewer.vmId === vmId &&
          viewer.watching?.owner === owner &&
          (options.windowId === undefined ||
            viewer.watching.windowId === options.windowId)
        )
          dropControl(vmId, viewer.watching.windowId);
      return send(vmId, {
        id: newFrameId(),
        type: "browser.release",
        owner,
        ...(options.windowId ? { windowId: options.windowId } : {}),
        ...(options.close ? { close: true } : {}),
      });
    },

    /** A page signed in: it can list, watch and, when it has control, act. */
    join(viewer: Viewer) {
      viewers.set(viewer.viewId, viewer);
    },

    /** Starts streaming a window to a viewer (stopping what it watched before). */
    watch(viewer: Viewer, window: Watched) {
      if (viewers.get(viewer.viewId) !== viewer) return;
      stopWatching(viewer);
      viewer.watching = window;
      const started = send(viewer.vmId, {
        id: newFrameId(),
        type: "screencast.start",
        viewId: viewer.viewId,
        targetId: window.targetId,
      });
      if (!started) {
        viewer.watching = undefined;
        viewer.socket.close(
          viewerCloseCodes.vmOffline,
          "The computer isn't connected right now.",
        );
        return;
      }
      tell(viewer, {
        type: "watching",
        windowId: window.windowId,
        control: controls(viewer),
      });
    },

    /** Whether a viewer has control of the window it's watching. */
    controls,

    /** Who has control of a window, if anyone (a view id). */
    controllerOf(vmId: string, windowId: string) {
      return control.get(key(vmId, windowId));
    },

    /** Whether the person has any window in hand on a VM (for the full desktop). */
    hasControl(vmId: string) {
      return [...control.keys()].some((window) =>
        window.startsWith(`${vmId}:`),
      );
    },

    /**
     * Gives a viewer control of the window it's watching (the person has
     * it: handed over or taken over). Whoever had it loses it.
     */
    grant(viewer: Viewer) {
      const watched = viewer.watching;
      if (!watched) return;
      const previous = control.get(key(viewer.vmId, watched.windowId));
      if (previous === viewer.viewId) return;
      if (previous) dropControl(viewer.vmId, watched.windowId);
      control.set(key(viewer.vmId, watched.windowId), viewer.viewId);
      tell(viewer, {
        type: "control",
        windowId: watched.windowId,
        yours: true,
      });
    },

    /** The page sent input: to the tab, if it's well formed and the page has control. */
    input(viewer: Viewer, data: unknown) {
      if (viewers.get(viewer.viewId) !== viewer || !controls(viewer)) return;
      const parsed = viewerInput.safeParse(data);
      if (!parsed.success) return;
      send(viewer.vmId, {
        id: newFrameId(),
        type: "input",
        viewId: viewer.viewId,
        input: parsed.data,
      });
    },

    /** The page went away: its stream stops, and its control goes. */
    disconnected(viewer: Viewer) {
      if (viewers.get(viewer.viewId) !== viewer) return;
      viewers.delete(viewer.viewId);
      stopWatching(viewer);
      for (const [window, holder] of control)
        if (holder === viewer.viewId) control.delete(window);
      closeDesktop(viewer.viewId, "The page closed.");
    },

    /** A page with control opened the full desktop: tunnel its VNC client to the VM's VNC server. */
    openDesktop(desktop: Viewer) {
      closeDesktop(desktop.viewId, "Opened again.");
      desktops.set(desktop.viewId, desktop);
      const opened = send(desktop.vmId, {
        id: newFrameId(),
        type: "desktop.open",
        viewId: desktop.viewId,
      });
      if (!opened) {
        desktops.delete(desktop.viewId);
        desktop.socket.close(
          viewerCloseCodes.vmOffline,
          "The computer isn't connected right now.",
        );
      }
    },

    /** Bytes from the page's VNC client, for the VM. */
    desktopInput(desktop: Viewer, bytes: Uint8Array) {
      if (desktops.get(desktop.viewId) !== desktop) return;
      sendBinary(desktop.vmId, desktopMessage(desktop.viewId, bytes));
    },

    /** The page closed the full desktop. */
    desktopDisconnected(desktop: Viewer) {
      if (desktops.get(desktop.viewId) !== desktop) return;
      desktops.delete(desktop.viewId);
      send(desktop.vmId, {
        id: newFrameId(),
        type: "desktop.close",
        viewId: desktop.viewId,
      });
    },

    /** A binary message from a VM: desktop bytes or a screencast frame, for its page only. */
    frame(vmId: string, message: Uint8Array) {
      const tunnelled = parseDesktopMessage(message);
      if (tunnelled) {
        const desktop = desktops.get(tunnelled.viewId);
        if (desktop?.vmId === vmId) desktop.socket.send(tunnelled.bytes);
        return;
      }
      const parsed = parseScreencastMessage(message);
      const viewer = parsed ? viewers.get(parsed.header.viewId) : undefined;
      // A frame for another VM's view never reaches its page.
      if (viewer?.vmId === vmId && viewer.watching) viewer.socket.send(message);
    },

    /** Frames for the registry; returns whether it took the frame. */
    handle(vmId: string, frame: VmToGatewayFrame) {
      if (
        frame.type === "browser.held" ||
        frame.type === "browser.transferred" ||
        frame.type === "browser.listed"
      ) {
        const pending = asks.get(frame.replyTo);
        if (!pending) return true;
        asks.delete(frame.replyTo);
        clearTimeout(pending.timer);
        pending.resolve(
          frame.type === "browser.listed" ? frame.windows : frame.window,
        );
        return true;
      }
      if (frame.type === "screencast.ended") {
        const viewer = viewers.get(frame.viewId);
        if (viewer?.vmId === vmId && viewer.watching) {
          logger.info(
            { viewId: frame.viewId, reason: frame.reason },
            "live view ended",
          );
          const { windowId } = viewer.watching;
          viewer.watching = undefined;
          control.delete(key(vmId, windowId));
          tell(viewer, {
            type: "ended",
            windowId,
            reason: frame.reason.slice(0, 120),
          });
        }
        return true;
      }
      if (frame.type === "desktop.closed") {
        const desktop = desktops.get(frame.viewId);
        if (desktop?.vmId === vmId) {
          desktops.delete(frame.viewId);
          desktop.socket.close(1000, frame.reason);
        }
        return true;
      }
      return false;
    },

    /** A VM disconnected: its pages are told it's offline, and sign in again. */
    vmClosed(vmId: string) {
      for (const viewer of [...viewers.values()])
        if (viewer.vmId === vmId) {
          viewers.delete(viewer.viewId);
          viewer.watching = undefined;
          viewer.socket.close(
            viewerCloseCodes.vmOffline,
            "The computer disconnected; reconnecting.",
          );
        }
      for (const window of [...control.keys()])
        if (window.startsWith(`${vmId}:`)) control.delete(window);
      for (const desktop of [...desktops.values()])
        if (desktop.vmId === vmId) {
          desktops.delete(desktop.viewId);
          desktop.socket.close(
            viewerCloseCodes.vmOffline,
            "The computer disconnected.",
          );
        }
    },
  };
}

export type Handoffs = ReturnType<typeof createHandoffs>;
