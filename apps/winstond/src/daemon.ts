import {
  gatewayToVmFrame,
  newFrameId,
  parseFrame,
  type VmToGatewayFrame,
} from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import { backoffDelayMs } from "./backoff.ts";
import { createHash } from "node:crypto";
import type { Executor } from "./exec.ts";
import { FileTransferError, type Files } from "./files.ts";
import { pushQueue } from "./queue.ts";
import type { TokenStore } from "./token-store.ts";

/** Liveness pings (docs/design.md §15). */
export const pingIntervalMs = 20_000;

/** File transfers move in chunks of at most this many bytes (base64 in a frame). */
export const fileChunkBytes = 256 * 1024;

/** Close codes the gateway uses. */
const replaced = 4000;
const registrationUsed = 4401;

export interface DaemonOptions {
  gatewayUrl: string;
  /** From the environment on first boot; unused once a VM token is stored. */
  registrationToken: string | undefined;
  tokens: TokenStore;
  executor: Executor;
  files: Files;
  versions: { winstond: string; cli: string | null };
  logger: Logger;
  /** For tests: faster reconnects and pings. */
  backoff?: (attempt: number) => number;
  pingEveryMs?: number;
}

/**
 * winstond's link to the gateway: connects with the stored VM token (or,
 * on first boot, the registration token), stores the VM token it's given,
 * says hello, pings, and reconnects with backoff whenever the connection
 * drops.
 */
export function createDaemon(options: DaemonOptions) {
  const { logger, tokens } = options;
  const backoff =
    options.backoff ?? ((attempt: number) => backoffDelayMs(attempt));
  let registrationToken = options.registrationToken;
  let attempt = 0;
  let stopped = false;
  let preferRegistration = false;
  let socket: WebSocket | undefined;
  let pinger: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** Uploads in progress, by transfer id: where their chunks go, and the next expected seq. */
  const uploads = new Map<
    string,
    { queue: ReturnType<typeof pushQueue<Uint8Array>>; seq: number }
  >();

  const send = (ws: WebSocket, frame: VmToGatewayFrame) => {
    ws.send(JSON.stringify(frame));
  };
  const hello = (ws: WebSocket) => {
    send(ws, {
      id: newFrameId(),
      type: "hello",
      cliVersion: options.versions.cli,
      winstondVersion: options.versions.winstond,
      capabilities: [],
    });
  };

  /** Which token to present: the stored one, unless it was just refused and a registration token exists. */
  const credential = async () => {
    const stored = await tokens.read();
    if (stored && !(preferRegistration && registrationToken))
      return { token: stored, registering: false };
    if (registrationToken)
      return { token: registrationToken, registering: true };
    return stored ? { token: stored, registering: false } : undefined;
  };

  const sendFileError = (ws: WebSocket, transferId: string, error: unknown) => {
    const failure =
      error instanceof FileTransferError
        ? error
        : new FileTransferError(
            "failed",
            error instanceof Error ? error.message : String(error),
          );
    if (ws.readyState === WebSocket.OPEN)
      send(ws, {
        id: newFrameId(),
        type: "file.error",
        transferId,
        code: failure.code,
        message: failure.message,
      });
  };

  /** Streams a file to the gateway as numbered chunks, then its size and hash. */
  const sendFile = async (ws: WebSocket, transferId: string, path: string) => {
    try {
      const hash = createHash("sha256");
      let size = 0;
      let seq = 0;
      for await (const chunk of await options.files.read(path)) {
        for (let at = 0; at < chunk.length; at += fileChunkBytes) {
          const piece = chunk.subarray(at, at + fileChunkBytes);
          hash.update(piece);
          size += piece.length;
          send(ws, {
            id: newFrameId(),
            type: "file.chunk",
            transferId,
            seq,
            data: Buffer.from(piece).toString("base64"),
          });
          seq += 1;
        }
      }
      send(ws, {
        id: newFrameId(),
        type: "file.done",
        transferId,
        size,
        sha256: hash.digest("hex"),
      });
    } catch (error) {
      sendFileError(ws, transferId, error);
    }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = backoff(attempt);
    attempt += 1;
    retry = setTimeout(() => void connect(), delay);
  };

  async function connect() {
    const chosen = await credential();
    if (!chosen) {
      logger.error(
        "no VM token and no registration token; nothing to connect with",
      );
      scheduleReconnect();
      return;
    }
    const url = new URL("/vm/connect", options.gatewayUrl);
    const ws = new WebSocket(url.href, {
      headers: { Authorization: `Bearer ${chosen.token}` },
    } as unknown as string[]);
    socket = ws;
    let opened = false;

    ws.addEventListener("open", () => {
      opened = true;
      attempt = 0;
      logger.info(
        { registering: chosen.registering },
        "connected to the gateway",
      );
      // With a stored token, say hello now; when registering, after the VM token is safely stored.
      if (!chosen.registering) hello(ws);
      pinger = setInterval(() => {
        send(ws, { id: newFrameId(), type: "ping" });
      }, options.pingEveryMs ?? pingIntervalMs);
    });

    ws.addEventListener("message", (event) => {
      const parsed = parseFrame(gatewayToVmFrame, String(event.data));
      if (!parsed.ok) {
        logger.warn(
          { error: parsed.error },
          "ignoring a malformed frame from the gateway",
        );
        return;
      }
      const frame = parsed.frame;
      if (frame.type === "registered") {
        void tokens.write(frame.vmToken).then(
          () => {
            registrationToken = undefined;
            preferRegistration = false;
            logger.info("registered; VM token stored");
            hello(ws);
          },
          (error: unknown) => {
            logger.error({ err: error }, "storing the VM token failed");
            ws.close();
          },
        );
      } else if (frame.type === "exec") {
        // Output streams on this connection only; after a reconnect the
        // gateway fetches the buffered result instead.
        const sendIfOpen = (out: VmToGatewayFrame) => {
          if (ws.readyState === WebSocket.OPEN) send(ws, out);
        };
        options.executor.run(frame, {
          output: (stream, data) => {
            sendIfOpen({
              id: newFrameId(),
              type: "exec.output",
              execId: frame.id,
              stream,
              data,
            });
          },
          exit: (result) => {
            sendIfOpen({
              id: newFrameId(),
              type: "exec.exit",
              execId: frame.id,
              ...result,
            });
          },
        });
      } else if (frame.type === "exec.fetch") {
        void options.executor.fetch(frame.execId).then((result) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          send(
            ws,
            result
              ? {
                  id: newFrameId(),
                  type: "exec.result",
                  execId: frame.execId,
                  found: true,
                  ...result,
                }
              : {
                  id: newFrameId(),
                  type: "exec.result",
                  execId: frame.execId,
                  found: false,
                  stdout: "",
                  stderr: "",
                  exitCode: null,
                  timedOut: false,
                  truncated: false,
                },
          );
        });
      } else if (frame.type === "file.read") {
        void sendFile(ws, frame.id, frame.path);
      } else if (frame.type === "file.write") {
        const queue = pushQueue<Uint8Array>();
        uploads.set(frame.id, { queue, seq: 0 });
        options.files
          .write(frame.path, { size: frame.size, sha256: frame.sha256 }, queue)
          .then(
            () => {
              send(ws, {
                id: newFrameId(),
                type: "file.done",
                transferId: frame.id,
                size: frame.size,
                sha256: frame.sha256,
              });
            },
            (error: unknown) => {
              sendFileError(ws, frame.id, error);
            },
          )
          .finally(() => uploads.delete(frame.id));
      } else if (frame.type === "file.chunk") {
        const upload = uploads.get(frame.transferId);
        if (!upload) return;
        if (frame.seq !== upload.seq) {
          upload.queue.fail(
            new FileTransferError(
              "failed",
              `chunk ${String(frame.seq)} arrived out of order`,
            ),
          );
          return;
        }
        upload.seq += 1;
        upload.queue.push(Buffer.from(frame.data, "base64"));
      } else if (frame.type === "file.end") {
        uploads.get(frame.transferId)?.queue.close();
      } else if (frame.type === "ping") {
        send(ws, { id: newFrameId(), type: "pong", replyTo: frame.id });
      } else if (frame.type === "error") {
        logger.warn(
          { code: frame.code, message: frame.message },
          "the gateway reported an error",
        );
      }
    });

    ws.addEventListener("close", (event) => {
      clearInterval(pinger);
      if (socket === ws) socket = undefined;
      if (!opened) {
        // Refused before opening: network trouble, or the token was rejected.
        // Try the other credential next time, if there is one.
        preferRegistration = !chosen.registering;
        logger.warn({ code: event.code }, "couldn't connect to the gateway");
      } else if (event.code === registrationUsed) {
        registrationToken = undefined;
        logger.error("the registration token was already used");
      } else if (event.code === replaced) {
        logger.warn("another connection replaced this one");
      } else {
        logger.warn({ code: event.code }, "disconnected from the gateway");
      }
      scheduleReconnect();
    });
  }

  return {
    start() {
      void connect();
    },
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(pinger);
      socket?.close();
    },
  };
}
