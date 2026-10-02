/**
 * The full-desktop fallback (docs/design.md §5 Browser handoff): for native
 * dialogs the tab's screencast can't show, the page opens a noVNC client
 * whose bytes come here over the gateway websocket. Each handoff gets one
 * TCP connection to the VNC server on the Xvfb display, which listens on
 * localhost only; nothing on the VM accepts connections from outside.
 */
import { createConnection, type Socket } from "node:net";
import {
  desktopMessage,
  newFrameId,
  type VmToGatewayFrame,
} from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";

/** x11vnc's port (image/scripts/chrome.sh). */
export const vncPort = 5900;

export function createDesktops(deps: {
  sendBinary: (message: Uint8Array) => void;
  sendFrame: (frame: VmToGatewayFrame) => void;
  logger: Logger;
  port?: number;
}) {
  const open = new Map<string, Socket>();

  return {
    open(handoffId: string) {
      open.get(handoffId)?.destroy();
      const socket = createConnection({
        host: "127.0.0.1",
        port: deps.port ?? vncPort,
      });
      open.set(handoffId, socket);
      socket.on("data", (bytes: Buffer) => {
        deps.sendBinary(desktopMessage(handoffId, bytes));
      });
      socket.on("error", (error) => {
        deps.logger.warn(
          { err: error, handoffId },
          "desktop connection failed",
        );
      });
      socket.on("close", () => {
        // Replaced by a newer open, or closed on purpose: nothing to report.
        if (open.get(handoffId) !== socket) return;
        open.delete(handoffId);
        deps.sendFrame({
          id: newFrameId(),
          type: "desktop.closed",
          handoffId,
          reason: "The desktop connection ended.",
        });
      });
    },

    /** Bytes from the page's VNC client. */
    write(handoffId: string, bytes: Uint8Array) {
      open.get(handoffId)?.write(bytes);
    },

    close(handoffId: string) {
      const socket = open.get(handoffId);
      open.delete(handoffId);
      socket?.destroy();
    },

    /** The gateway connection dropped: its pages are gone too. */
    closeAll() {
      for (const handoffId of [...open.keys()]) this.close(handoffId);
    },
  };
}

export type Desktops = ReturnType<typeof createDesktops>;
