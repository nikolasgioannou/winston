/**
 * winstond: the only process on a VM that holds a credential, and the only
 * one talking to the backend (docs/design.md §10, §15). Runs as the
 * `winstond` user under systemd.
 */
import { createLogger } from "@winston/shared/logger";
import packageJson from "../package.json" with { type: "json" };
import { createDaemon } from "./daemon.ts";
import { tokenStore } from "./token-store.ts";

// Docker passes these as environment variables (the unit's PassEnvironment=);
// EC2 will pass them in instance user data. Either way, read them here.
const gatewayUrl = process.env.WINSTON_GATEWAY_URL;
if (!gatewayUrl) {
  console.error("WINSTON_GATEWAY_URL isn't set");
  process.exit(1);
}

/** An unset or empty variable counts as absent. */
const nonEmpty = (value: string | undefined) =>
  value === "" ? undefined : value;

const logger = createLogger("winstond", { pretty: false });
const daemon = createDaemon({
  gatewayUrl,
  registrationToken: nonEmpty(process.env.WINSTON_REGISTRATION_TOKEN),
  tokens: tokenStore(process.env.WINSTOND_TOKEN_PATH ?? "/etc/winstond/token"),
  versions: { winstond: packageJson.version, cli: null },
  logger,
});
daemon.start();

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    daemon.stop();
    process.exit(0);
  });
