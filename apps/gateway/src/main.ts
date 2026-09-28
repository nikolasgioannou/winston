/**
 * The gateway service: holds every VM's websocket, registers new VMs, and
 * serves the internal API (docs/design.md §9, §15).
 */
import { createDb } from "@winston/db/client";
import { createLogger } from "@winston/shared/logger";
import { loadGatewayConfig } from "./config.ts";
import { createGateway } from "./gateway.ts";
import { sweepVms } from "./liveness.ts";
import type { VmSocketData } from "./vm-socket.ts";

const config = loadGatewayConfig();
const logger = createLogger("gateway", {
  level: config.LOG_LEVEL,
  pretty: config.LOG_PRETTY,
});
const db = createDb(config.DATABASE_URL);
const gateway = createGateway({
  db,
  logger,
  internalSecret: config.GATEWAY_INTERNAL_SECRET,
});
const server = Bun.serve<VmSocketData>({
  hostname: config.GATEWAY_HOST,
  port: config.GATEWAY_PORT,
  fetch: gateway.fetch,
  websocket: gateway.websocket,
});

// Timeouts: silent VMs become unhealthy, stuck ones fail (§17).
const sweeper = setInterval(() => {
  sweepVms(db, logger).catch((error: unknown) => {
    logger.error({ err: error }, "sweeping VMs failed");
  });
}, 30_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) process.exit(1);
  stopping = true;
  logger.info({ signal }, "stopping");
  clearInterval(sweeper);
  // Closes VM sockets; they reconnect to another gateway or after restart.
  await server.stop(true);
  await db.$client.end();
  logger.info("stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info({ url: server.url.href }, "gateway listening");
