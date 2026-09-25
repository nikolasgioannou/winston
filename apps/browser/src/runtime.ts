import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";

const childEnvironment = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/data/profile",
  DISPLAY: ":99",
  LANG: "C.UTF-8",
};

// This module is private to the broker. No browser object or pipe is exposed over HTTP.
export async function launchBrowserRuntime(options: { profile: string; onFailure: () => void }) {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Browser runtime requires its isolated Linux container.");
  if (process.env.WINSTON_BROWSER_LOCKED !== "1" || options.profile !== "/data/profile")
    throw new Error("Browser runtime requires the locked profile volume.");

  // The entrypoint's flock and whole-container restart establish exclusivity.
  // Chromium's hostname/PID links otherwise survive a crash and reject a new host.
  const locks = ["SingletonLock", "SingletonSocket", "SingletonCookie"].map((name) =>
    join(options.profile, name),
  );
  for (const path of locks) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isSymbolicLink() || stat.uid !== 1000))
      throw new Error("Browser process lock is not a recognized profile symlink.");
  }
  for (const path of locks) {
    if (lstatSync(path, { throwIfNoEntry: false })) unlinkSync(path);
  }

  const display = Bun.spawn(
    [
      "/usr/bin/setpriv",
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "--no-new-privs",
      "--bounding-set=-all",
      "/usr/bin/Xvfb",
      ":99",
      "-screen",
      "0",
      "1280x900x24",
      "-nolisten",
      "tcp",
      "-ac",
    ],
    { env: childEnvironment, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  let context: BrowserContext | undefined;
  let closing = false;
  let closed: Promise<void> | undefined;
  display.exited.then(
    () => {
      if (!closing) options.onFailure();
    },
    () => {
      if (!closing) options.onFailure();
    },
  );

  async function close() {
    closed ??= (async () => {
      closing = true;
      try {
        await context?.close({ reason: "Browser runtime stopping" });
      } finally {
        display.kill("SIGTERM");
        const force = setTimeout(() => {
          display.kill("SIGKILL");
        }, 3000);
        try {
          await display.exited;
        } finally {
          clearTimeout(force);
        }
      }
    })();
    return closed;
  }

  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (display.exitCode !== null) throw new Error("Browser display exited.");
      if (lstatSync("/tmp/.X11-unix/X99", { throwIfNoEntry: false })?.isSocket()) break;
      if (attempt === 99) throw new Error("Browser display did not become ready.");
      await Bun.sleep(50);
    }
    context = await chromium.launchPersistentContext(options.profile, {
      executablePath: "/usr/local/bin/browser-chromium",
      headless: false,
      chromiumSandbox: true,
      env: childEnvironment,
      viewport: { width: 1280, height: 820 },
      timeout: 30_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      acceptDownloads: false,
    });
    context.on("close", () => {
      if (!closing) options.onFailure();
    });
    return { context, close };
  } catch (error) {
    await close();
    throw new Error("Browser runtime could not start.", { cause: error });
  }
}
