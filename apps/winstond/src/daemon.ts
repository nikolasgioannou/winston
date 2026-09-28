import {
  gatewayToVmFrame,
  newFrameId,
  parseFrame,
  type VmToGatewayFrame,
} from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import { backoffDelayMs } from "./backoff.ts";
import type { TokenStore } from "./token-store.ts";

/** Liveness pings (docs/design.md §15). */
export const pingIntervalMs = 20_000;

/** Close codes the gateway uses. */
const replaced = 4000;
const registrationUsed = 4401;

export interface DaemonOptions {
  gatewayUrl: string;
  /** From the environment on first boot; unused once a VM token is stored. */
  registrationToken: string | undefined;
  tokens: TokenStore;
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
