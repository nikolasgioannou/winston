/**
 * Browser handoff in the gateway (docs/design.md §5, §15): holding and
 * releasing a run's window on its VM, and relaying a live view between the
 * page at `/t/<token>` and that one tab. The page's socket carries nothing
 * but that tab's frames one way and the person's input the other.
 */
import {
  desktopMessage,
  newFrameId,
  parseDesktopMessage,
  parseScreencastMessage,
  viewerInput,
  type GatewayToVmFrame,
  type VmToGatewayFrame,
} from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import { VmUnavailableError, VmUnreachableError } from "./execs.ts";

/** What a viewer socket needs: send to the page, and close it. */
export interface ViewerSocket {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
}

export interface Viewer {
  handoffId: string;
  vmId: string;
  /** Whose window it is, as winstond names runs (`front`, or a run id). */
  owner: string;
  targetId: string;
  socket: ViewerSocket;
}

/** Close codes the page reads (docs/design.md §5). */
export const viewerCloseCodes = {
  /** The task carried on, or the tab went away: the live view is over. */
  ended: 4000,
  /** The computer isn't connected; the page may retry. */
  vmOffline: 4001,
  /** Someone else opened this handoff's live view. */
  replaced: 4002,
} as const;

const holdTimeoutMs = 10_000;

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
  const holds = new Map<
    string,
    { resolve: (window: HeldWindow | null) => void; timer: Timer }
  >();
  const viewers = new Map<string, Viewer>();
  /** Full-desktop fallbacks (noVNC), by handoff: at most one each. */
  const desktops = new Map<string, Viewer>();

  function closeDesktop(handoffId: string, code: number, reason: string) {
    const desktop = desktops.get(handoffId);
    if (!desktop) return;
    desktops.delete(handoffId);
    send(desktop.vmId, { id: newFrameId(), type: "desktop.close", handoffId });
    desktop.socket.close(code, reason);
  }

  function stop(viewer: Viewer, code: number, reason: string) {
    if (viewers.get(viewer.handoffId) !== viewer) return;
    viewers.delete(viewer.handoffId);
    send(viewer.vmId, {
      id: newFrameId(),
      type: "screencast.stop",
      handoffId: viewer.handoffId,
    });
    viewer.socket.close(code, reason);
    closeDesktop(viewer.handoffId, code, reason);
  }

  return {
    /** Asks a VM to hold an owner's current window for the user. */
    hold(vmId: string, owner: string): Promise<HeldWindow | null> {
      const id = newFrameId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          holds.delete(id);
          reject(new VmUnreachableError());
        }, holdTimeoutMs);
        holds.set(id, { resolve, timer });
        if (!send(vmId, { id, type: "browser.hold", owner })) {
          clearTimeout(timer);
          holds.delete(id);
          reject(new VmUnavailableError());
        }
      });
    },

    /** Lets an owner's windows go, and ends their live views. */
    release(vmId: string, owner: string) {
      for (const viewer of [...viewers.values()])
        if (viewer.vmId === vmId && viewer.owner === owner)
          stop(viewer, viewerCloseCodes.ended, "The task carried on.");
      for (const desktop of [...desktops.values()])
        if (desktop.vmId === vmId && desktop.owner === owner)
          closeDesktop(
            desktop.handoffId,
            viewerCloseCodes.ended,
            "The task carried on.",
          );
      send(vmId, { id: newFrameId(), type: "browser.release", owner });
    },

    /** A page opened a live view: start streaming that tab to it. */
    connect(viewer: Viewer) {
      const previous = viewers.get(viewer.handoffId);
      if (previous) {
        // One live view per handoff: the newest (a reconnect) wins.
        viewers.delete(viewer.handoffId);
        previous.socket.close(viewerCloseCodes.replaced, "Opened elsewhere.");
      }
      viewers.set(viewer.handoffId, viewer);
      const started = send(viewer.vmId, {
        id: newFrameId(),
        type: "screencast.start",
        handoffId: viewer.handoffId,
        targetId: viewer.targetId,
      });
      if (!started) {
        viewers.delete(viewer.handoffId);
        viewer.socket.close(
          viewerCloseCodes.vmOffline,
          "The computer isn't connected right now.",
        );
      }
    },

    /** The page sent input: pass it to the tab, if it's well formed. */
    input(viewer: Viewer, text: string) {
      if (viewers.get(viewer.handoffId) !== viewer) return;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }
      const parsed = viewerInput.safeParse(data);
      if (!parsed.success) return;
      send(viewer.vmId, {
        id: newFrameId(),
        type: "input",
        handoffId: viewer.handoffId,
        input: parsed.data,
      });
    },

    /** The page went away: stop the screencast (the handoff stays connected). */
    disconnected(viewer: Viewer) {
      if (viewers.get(viewer.handoffId) !== viewer) return;
      viewers.delete(viewer.handoffId);
      send(viewer.vmId, {
        id: newFrameId(),
        type: "screencast.stop",
        handoffId: viewer.handoffId,
      });
    },

    /**
     * A page opened the full desktop (its handoff is connected): tunnel its
     * VNC client to the VM's VNC server.
     */
    openDesktop(desktop: Viewer) {
      closeDesktop(
        desktop.handoffId,
        viewerCloseCodes.replaced,
        "Opened elsewhere.",
      );
      desktops.set(desktop.handoffId, desktop);
      const opened = send(desktop.vmId, {
        id: newFrameId(),
        type: "desktop.open",
        handoffId: desktop.handoffId,
      });
      if (!opened) {
        desktops.delete(desktop.handoffId);
        desktop.socket.close(
          viewerCloseCodes.vmOffline,
          "The computer isn't connected right now.",
        );
      }
    },

    /** Bytes from the page's VNC client, for the VM. */
    desktopInput(desktop: Viewer, bytes: Uint8Array) {
      if (desktops.get(desktop.handoffId) !== desktop) return;
      sendBinary(desktop.vmId, desktopMessage(desktop.handoffId, bytes));
    },

    /** The page closed the full desktop. */
    desktopDisconnected(desktop: Viewer) {
      if (desktops.get(desktop.handoffId) !== desktop) return;
      desktops.delete(desktop.handoffId);
      send(desktop.vmId, {
        id: newFrameId(),
        type: "desktop.close",
        handoffId: desktop.handoffId,
      });
    },

    /**
     * A binary message from a VM: desktop bytes or a screencast frame, for
     * its page only.
     */
    frame(vmId: string, message: Uint8Array) {
      const tunnelled = parseDesktopMessage(message);
      if (tunnelled) {
        const desktop = desktops.get(tunnelled.handoffId);
        if (desktop?.vmId === vmId) desktop.socket.send(tunnelled.bytes);
        return;
      }
      const parsed = parseScreencastMessage(message);
      const viewer = parsed ? viewers.get(parsed.header.handoffId) : undefined;
      // A frame for another VM's handoff never reaches its page.
      if (viewer?.vmId === vmId) viewer.socket.send(message);
    },

    /** Frames for the handoff registry; returns whether it took the frame. */
    handle(vmId: string, frame: VmToGatewayFrame) {
      if (frame.type === "browser.held") {
        const pending = holds.get(frame.replyTo);
        if (!pending) return true;
        holds.delete(frame.replyTo);
        clearTimeout(pending.timer);
        pending.resolve(frame.window);
        return true;
      }
      if (frame.type === "screencast.ended") {
        const viewer = viewers.get(frame.handoffId);
        if (viewer?.vmId === vmId) {
          logger.info(
            { handoffId: frame.handoffId, reason: frame.reason },
            "live view ended",
          );
          viewers.delete(frame.handoffId);
          viewer.socket.close(
            viewerCloseCodes.ended,
            frame.reason.slice(0, 120),
          );
        }
        return true;
      }
      if (frame.type === "desktop.closed") {
        const desktop = desktops.get(frame.handoffId);
        if (desktop?.vmId === vmId) {
          desktops.delete(frame.handoffId);
          desktop.socket.close(viewerCloseCodes.ended, frame.reason);
        }
        return true;
      }
      return false;
    },

    /** A VM disconnected: its pages are told it's offline. */
    vmClosed(vmId: string) {
      for (const viewer of [...viewers.values()])
        if (viewer.vmId === vmId) {
          viewers.delete(viewer.handoffId);
          viewer.socket.close(
            viewerCloseCodes.vmOffline,
            "The computer disconnected; reconnecting.",
          );
        }
      for (const desktop of [...desktops.values()])
        if (desktop.vmId === vmId) {
          desktops.delete(desktop.handoffId);
          desktop.socket.close(
            viewerCloseCodes.vmOffline,
            "The computer disconnected.",
          );
        }
    },
  };
}

export type Handoffs = ReturnType<typeof createHandoffs>;
