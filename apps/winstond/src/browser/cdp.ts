/**
 * A minimal Chrome DevTools Protocol client over one websocket to the
 * browser (docs/design.md §5: raw CDP, not a library). Page sessions are
 * flat (`Target.attachToTarget` with `flatten`), so every command and event
 * travels on this one socket, tagged with its `sessionId`.
 */

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface Cdp {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
  /** Listens to every event; returns a function that stops listening. */
  on(listener: (event: CdpEvent) => void): () => void;
  /** Resolves when the socket closes (Chrome exited or restarted). */
  closed: Promise<void>;
  close(): void;
}

/** A CDP command Chrome answered with an error. */
export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
  }
}

const commandTimeoutMs = 30_000;

/** Chrome's browser-level websocket, from its DevTools HTTP endpoint. */
export async function browserSocketUrl(devtools = "http://127.0.0.1:9222") {
  const response = await fetch(`${devtools}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl)
    throw new Error("Chrome didn't say where its DevTools socket is");
  return body.webSocketDebuggerUrl;
}

export function connectCdp(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map<
      number,
      {
        method: string;
        resolve: (value: Record<string, unknown>) => void;
        reject: (error: Error) => void;
        timer: Timer;
      }
    >();
    const listeners = new Set<(event: CdpEvent) => void>();
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((done) => (markClosed = done));

    ws.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      if (data.id !== undefined) {
        const call = pending.get(data.id);
        if (!call) return;
        pending.delete(data.id);
        clearTimeout(call.timer);
        if (data.error)
          call.reject(new CdpError(call.method, data.error.message));
        else call.resolve(data.result ?? {});
        return;
      }
      if (data.method) {
        const event: CdpEvent = {
          method: data.method,
          params: data.params ?? {},
          ...(data.sessionId ? { sessionId: data.sessionId } : {}),
        };
        for (const listener of listeners) listener(event);
      }
    });
    ws.addEventListener("close", () => {
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new CdpError(call.method, "Chrome closed the connection"));
      }
      pending.clear();
      markClosed();
    });
    ws.addEventListener("error", () => {
      reject(new Error("Couldn't connect to Chrome's DevTools socket"));
    });
    ws.addEventListener("open", () => {
      resolve({
        send<T>(
          method: string,
          params: Record<string, unknown> = {},
          sessionId?: string,
        ) {
          const id = nextId++;
          return new Promise<T>((done, fail) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              fail(new CdpError(method, "Chrome didn't answer in time"));
            }, commandTimeoutMs);
            pending.set(id, {
              method,
              resolve: (value) => {
                done(value as T);
              },
              reject: fail,
              timer,
            });
            ws.send(
              JSON.stringify({
                id,
                method,
                params,
                ...(sessionId ? { sessionId } : {}),
              }),
            );
          });
        },
        on(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        closed,
        close() {
          ws.close();
        },
      });
    });
  });
}
