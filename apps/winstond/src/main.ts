/**
 * winstond: the only process on a VM that holds a credential, and the only
 * one talking to the backend (docs/design.md §10, §15). Runs as the
 * `winstond` user under systemd.
 */
import { newFrameId } from "@winston/domain/frames";
import { createLogger } from "@winston/shared/logger";
import { browserSocketUrl, connectCdp } from "./browser/cdp.ts";
import { handoffFrames } from "./browser/handoff-frames.ts";
import { browserRpc, isBrowserPath } from "./browser/rpc.ts";
import { createScreencasts } from "./browser/screencast.ts";
import { createBrowser } from "./browser/windows.ts";
import { watchChrome } from "./chrome-watch.ts";
import { serveCliSocket } from "./cli-socket.ts";
import { createDaemon } from "./daemon.ts";
import { createExecutor } from "./exec.ts";
import { helperFiles, runFileHelper } from "./files.ts";
import { tokenStore } from "./token-store.ts";
import { signingPublicKey } from "./signing-key.ts";
import { applyUpdate, confirmUpdate } from "./updater.ts";
import { readUserData } from "./user-data.ts";
import { version } from "./version.ts";

// Helper mode: winstond re-invokes itself as winston for file operations.
const [command] = Bun.argv.slice(2);
if (command === "file-read" || command === "file-write")
  process.exit(await runFileHelper(Bun.argv.slice(2)));

/** An unset or empty variable counts as absent. */
const nonEmpty = (value: string | undefined) =>
  value === "" ? undefined : value;

// Docker passes these as environment variables (the unit's PassEnvironment=);
// on EC2 they're in the instance's user data.
const fromEnv = {
  gatewayUrl: nonEmpty(process.env.WINSTON_GATEWAY_URL),
  registrationToken: nonEmpty(process.env.WINSTON_REGISTRATION_TOKEN),
};
const settings = fromEnv.gatewayUrl ? fromEnv : await readUserData();
const { gatewayUrl } = settings;
if (!gatewayUrl) {
  console.error("WINSTON_GATEWAY_URL isn't set, and there's no user data");
  process.exit(1);
}

/** The installed CLI's version, reported in hello; null if there's no CLI. */
async function cliVersion() {
  try {
    const proc = Bun.spawn(
      [process.env.WINSTON_CLI ?? "/usr/local/bin/winston", "--version"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const output = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && output ? output : null;
  } catch {
    return null;
  }
}

const logger = createLogger("winstond", { pretty: false });
/** winstond's own directory, which holds both binaries (updater.ts). */
const dir = process.env.WINSTOND_DIR ?? "/usr/local/lib/winstond";
const versions = { winstond: version, cli: await cliVersion() };
// The browser's state lives here, since every CLI call is a new process.
const files = helperFiles();
const browser = createBrowser({
  connect: async () => connectCdp(await browserSocketUrl()),
  // Screenshots are written as winston, like every file in its home.
  saveFile: (path, bytes) =>
    files.write(
      path,
      {
        size: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      },
      new Blob([bytes]).stream(),
    ),
});
// The live view of a handed-over tab streams through the daemon's connection.
const screencasts = createScreencasts({
  connection: () => browser.connection(),
  sendBinary: (message) => {
    daemon.sendBinary(message);
  },
  sendFrame: (frame) => {
    daemon.sendFrame(frame);
  },
  newFrameId,
  logger,
});
const executor = createExecutor();
const daemon = createDaemon({
  gatewayUrl,
  registrationToken: settings.registrationToken,
  executor,
  files: helperFiles(),
  tokens: tokenStore(process.env.WINSTOND_TOKEN_PATH ?? "/etc/winstond/token"),
  versions,
  updates: {
    apply: (frame) =>
      applyUpdate(frame, { dir, publicKeyPem: signingPublicKey, versions }),
    confirm: () => confirmUpdate(dir),
    restart: () => process.exit(0),
    idle: () => !executor.busy() && !browser.hasWindows(),
  },
  browser: handoffFrames({
    browser,
    screencasts,
    sendFrame: (frame) => {
      daemon.sendFrame(frame);
    },
    logger,
  }),
  logger,
});
daemon.start();
const stopChromeWatch = watchChrome(logger);
const browserSweep = setInterval(() => void browser.sweep(), 60_000);
await serveCliSocket(
  process.env.WINSTOND_SOCKET ?? "/run/winstond/winstond.sock",
  (request) => daemon.rpc(request),
  { handles: isBrowserPath, rpc: browserRpc(browser) },
);

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    daemon.stop();
    stopChromeWatch();
    clearInterval(browserSweep);
    process.exit(0);
  });
