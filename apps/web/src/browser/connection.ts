/**
 * The browser page's socket to the gateway (docs/design.md §5): it signs in
 * with a ticket from the page's own server, then asks for the windows, the
 * one to watch and control, and sends input. After a drop (phone networks
 * blip, the computer reconnects) it signs in again with a fresh ticket.
 * Frames arrive as binary; everything else is JSON.
 */
import {
  parseScreencastMessage,
  type ScreencastHeader,
  type ViewerInput,
} from "@winston/domain/frames";

export type ConnectionState = "connecting" | "live" | "reconnecting";

/** What the gateway tells the page. */
export type GatewayMessage = { type: string } & Record<string, unknown>;

const retryDelaysMs = [1000, 2000, 4000, 8000, 10_000];

export function connectBrowser({
  url,
  ticket,
  onState,
  onMessage,
  onFrame,
}: {
  /** The gateway's socket: wss://gateway…/browser/connect. */
  url: string;
  /** A fresh ticket from the page's server, for each sign-in. */
  ticket: () => Promise<string>;
  onState: (state: ConnectionState) => void;
  onMessage: (message: GatewayMessage) => void;
  onFrame: (header: ScreencastHeader, jpeg: Uint8Array) => void;
}) {
  let socket: WebSocket | undefined;
  let attempts = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const again = () => {
    if (stopped) return;
    const delay =
      retryDelaysMs[Math.min(attempts, retryDelaysMs.length - 1)] ?? 10_000;
    attempts += 1;
    retry = setTimeout(() => {
      void open();
    }, delay);
  };

  async function open() {
    let signIn: string;
    try {
      signIn = await ticket();
    } catch {
      onState("reconnecting");
      again();
      return;
    }
    if (stopped) return;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", ticket: signIn }));
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as GatewayMessage;
        if (message.type === "ready") {
          attempts = 0;
          onState("live");
        }
        onMessage(message);
        return;
      }
      const frame = parseScreencastMessage(
        new Uint8Array(event.data as ArrayBuffer),
      );
      if (frame) onFrame(frame.header, frame.jpeg);
    });
    ws.addEventListener("close", () => {
      if (socket !== ws || stopped) return;
      onState("reconnecting");
      again();
    });
  }

  const send = (message: unknown) => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };

  onState("connecting");
  void open();
  return {
    /** Lists the windows, watches one, takes control, or hands back (Done). */
    ask(
      message:
        | { type: "windows" }
        | { type: "watch"; windowId: string }
        | { type: "control" }
        | { type: "done" },
    ) {
      send(message);
    },
    /** Input for the watched tab (it reaches it only while the page has control). */
    send(input: ViewerInput) {
      send(input);
    },
    close() {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    },
  };
}
