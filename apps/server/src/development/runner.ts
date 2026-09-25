import { setTimeout as sleep } from "node:timers/promises";

// The detached runner owns one process group containing its development services.
// Never look up or signal processes by name or by the port they happen to use.
export async function runDevelopmentCommand(
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
    graceMs?: number;
  },
) {
  if (process.platform === "win32")
    throw new Error("Local stack supervision requires macOS or Linux.");
  const isAborted = () => options.signal.aborted;
  if (isAborted()) return 0;
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  let gone = false;
  const send = (signal: NodeJS.Signals | 0) => {
    if (gone) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      gone = true;
      return false;
    }
  };
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      send("SIGTERM");
      const deadline = Date.now() + (options.graceMs ?? 10_000);
      while (send(0) && Date.now() < deadline) await sleep(25);
      if (send(0)) send("SIGKILL");
      await child.exited;
    })();
    return stopping;
  };
  const aborted = () => {
    stop().catch(() => {
      child.kill("SIGKILL");
    });
  };
  options.signal.addEventListener("abort", aborted, { once: true });
  if (isAborted()) aborted();
  try {
    const code = await child.exited;
    return isAborted() ? 0 : code;
  } finally {
    options.signal.removeEventListener("abort", aborted);
    await stop();
  }
}
