/**
 * The live view's socket to the gateway (docs/design.md §5): it signs in
 * with the link's token, keeps the session secret it's given (for this
 * browser tab only), and reconnects with it after a drop, since phone
 * networks blip. Frames arrive as binary; input goes out as JSON.
 */
import {
  parseScreencastMessage,
  type ScreencastHeader,
  type ViewerInput,
} from "@winston/domain/frames";
import { closedState, type LiveState } from "./input";

export interface SessionStore {
  get(token: string): { handoff: string; secret: string } | undefined;
  set(token: string, session: { handoff: string; secret: string }): void;
}

/** Session secrets in sessionStorage, when it's there (private modes may refuse). */
export const browserSessions: SessionStore = {
  get(token) {
    try {
      const raw = sessionStorage.getItem(`winston-handoff:${token}`);
      return raw
        ? (JSON.parse(raw) as { handoff: string; secret: string })
        : undefined;
    } catch {
      return undefined;
    }
  },
  set(token, session) {
    try {
      sessionStorage.setItem(
        `winston-handoff:${token}`,
        JSON.stringify(session),
      );
    } catch {
      // Without storage a reload can't reconnect; the open page still can.
    }
  },
};

const retryDelaysMs = [1000, 2000, 4000, 8000, 10_000];

export function connectLiveView({
  url,
  token,
  sessions,
  onState,
  onFrame,
}: {
  /** The gateway's live-view socket: wss://gateway…/handoff/connect. */
  url: string;
  token: string;
  sessions: SessionStore;
  onState: (state: LiveState) => void;
  onFrame: (header: ScreencastHeader, jpeg: Uint8Array) => void;
}) {
  let session = sessions.get(token);
  let socket: WebSocket | undefined;
  let attempts = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function open() {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify(
          session
            ? { type: "auth", handoff: session.handoff, secret: session.secret }
            : { type: "auth", token },
        ),
      );
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as {
          type?: string;
          handoff?: string;
          secret?: string;
        };
        if (message.type === "session" && message.handoff && message.secret) {
          session = { handoff: message.handoff, secret: message.secret };
          sessions.set(token, session);
        }
        return;
      }
      const frame = parseScreencastMessage(
        new Uint8Array(event.data as ArrayBuffer),
      );
      if (!frame) return;
      attempts = 0;
      onState("live");
      onFrame(frame.header, frame.jpeg);
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws || stopped) return;
      const state = closedState(event.code, session !== undefined);
      onState(state);
      if (state !== "reconnecting") return;
      const delay =
        retryDelaysMs[Math.min(attempts, retryDelaysMs.length - 1)] ?? 10_000;
      attempts += 1;
      retry = setTimeout(open, delay);
    });
  }

  onState(session ? "reconnecting" : "connecting");
  open();
  return {
    send(input: ViewerInput) {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(input));
    },
    /** Hands the browser back to Winston; the page then hears it's over. */
    done() {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "done" }));
    },
    close() {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    },
  };
}
