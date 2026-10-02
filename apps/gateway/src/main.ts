/**
 * The gateway service: holds every VM's websocket, registers new VMs, and
 * serves the internal API (docs/design.md §9, §15).
 */
import { networkInterfaces } from "node:os";
import { googleAccessTokens } from "@winston/connectors/access-token";
import { gmailProvider } from "@winston/connectors/gmail";
import { googleCalendarProvider } from "@winston/connectors/google-calendar";
import { reconnectUrlFor } from "@winston/connectors/grants";
import { createDb } from "@winston/db/client";
import { createTokenVault } from "@winston/shared/token-vault";
import { createLogger } from "@winston/shared/logger";
import { s3Artifacts } from "./artifacts.ts";
import { loadGatewayConfig } from "./config.ts";
import { createGateway, type GatewaySocketData } from "./gateway.ts";
import { sweepVms } from "./liveness.ts";
import { privateAddress } from "./self-url.ts";
import { openRouterJev } from "@winston/vm-api/jev";

const config = loadGatewayConfig();
const logger = createLogger("gateway", {
  level: config.LOG_LEVEL,
  pretty: config.LOG_PRETTY,
});
const db = createDb(config.DATABASE_URL, {
  rdsSecretArn: config.DATABASE_SECRET_ARN,
});
// Connected accounts' access tokens, for mail and calendar calls (§12a).
const accessToken = googleAccessTokens({
  db,
  vault: createTokenVault(config),
  client: {
    clientId: config.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
  },
  reconnectUrl: reconnectUrlFor(config.WEB_PUBLIC_URL),
});
/** This task's own address: in ECS, its network interface's private IPv4. */
function ownUrl() {
  if (config.GATEWAY_ADVERTISE_URL) return config.GATEWAY_ADVERTISE_URL;
  if (config.GATEWAY_HOST !== "0.0.0.0")
    return `http://${config.GATEWAY_HOST}:${String(config.GATEWAY_PORT)}`;
  const address = privateAddress(networkInterfaces());
  return address
    ? `http://${address}:${String(config.GATEWAY_PORT)}`
    : undefined;
}
const selfUrl = ownUrl();
logger.info({ selfUrl }, "advertising this gateway to agents");
const gateway = createGateway({
  db,
  logger,
  ...(selfUrl ? { selfUrl } : {}),
  internalSecret: config.GATEWAY_INTERNAL_SECRET,
  ...(config.OPENROUTER_API_KEY
    ? { jev: openRouterJev({ apiKey: config.OPENROUTER_API_KEY }) }
    : {}),
  runTokenSecret: config.RUN_TOKEN_SECRET,
  ...(config.ARTIFACTS_BUCKET
    ? { artifacts: s3Artifacts(config.ARTIFACTS_BUCKET) }
    : {}),
  connectors: {
    webPublicUrl: config.WEB_PUBLIC_URL,
    mail: (connection) =>
      gmailProvider({
        address: connection.externalEmail,
        accessToken: () => accessToken(connection.id),
      }),
    calendar: (connection) =>
      googleCalendarProvider({
        address: connection.externalEmail,
        accessToken: () => accessToken(connection.id),
      }),
  },
});
// New VM binaries reach connected VMs within a minute of being published.
const refreshUpdates = () => {
  gateway.updates.refresh().catch((error: unknown) => {
    logger.error({ err: error }, "reading the VM manifest failed");
  });
};
refreshUpdates();
const updateChecker = setInterval(refreshUpdates, 60_000);
const server = Bun.serve<GatewaySocketData>({
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
  clearInterval(updateChecker);
  // Closes VM sockets; they reconnect to another gateway or after restart.
  await server.stop(true);
  await db.$client.end();
  logger.info("stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info({ url: server.url.href }, "gateway listening");
