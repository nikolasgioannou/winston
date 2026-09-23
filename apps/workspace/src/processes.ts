import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  commandExitSchema,
  commandInputSchema,
  commandOutputChannelSchema,
  type CommandInput,
  type CommandResult,
  type CommandOutputChannel,
} from "@winston/contracts/commands";
import { commandOutput } from "./command-output";
import { workspaceOperationSchema } from "@winston/contracts/workspace";

function syncDirectory(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function createCommandRunner(options: {
  home: string;
  logsRoot: string;
  supervisorPath: string;
}) {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Commands require the protected Linux runtime.");
  const parent = lstatSync(dirname(options.logsRoot));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== 0 ||
    (parent.mode & 0o077) !== 0
  )
    throw new Error("Command output requires a private runtime directory.");
  mkdirSync(options.logsRoot, { mode: 0o700, recursive: true });
  syncDirectory(dirname(options.logsRoot));
  const logs = lstatSync(options.logsRoot);
  if (!logs.isDirectory() || logs.isSymbolicLink() || logs.uid !== 0 || (logs.mode & 0o077) !== 0)
    throw new Error("Command output directory is unsafe.");
  const home = realpathSync(options.home);
  const active = new Map<string, { cancel(): void; result: Promise<CommandResult> }>();
  let closing = false;

  return {
    output(id: string, channel: CommandOutputChannel, bytes: number) {
      workspaceOperationSchema.shape.operationId.parse(id);
      commandOutputChannelSchema.parse(channel);
      const path = join(options.logsRoot, id, channel);
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== 0 ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size !== bytes
      )
        throw new Error("Command output is unavailable.");
      return Bun.file(path).stream();
    },
    start(id: string, input: CommandInput) {
      if (closing) throw new Error("Workspace command runner is stopping.");
      workspaceOperationSchema.shape.operationId.parse(id);
      if (active.has(id)) throw new Error("Command identity unavailable.");
      if (active.size >= 4) throw new Error("Workspace command capacity reached.");
      const command = commandInputSchema.parse(input);
      const cwd = realpathSync(command.cwd);
      const path = relative(home, cwd);
      if (path === ".." || path.startsWith("../") || path.startsWith("/"))
        throw new Error("Command directory must be inside the workspace home.");
      const directory = join(options.logsRoot, id);
      mkdirSync(directory, { mode: 0o700 });
      const receiptPath = join(directory, "exit.json");
      const started = performance.now();
      const stdout = commandOutput();
      const stderr = commandOutput();
      let processHandle: { pid: number } | undefined;
      let alive = false;
      let settled = false;
      let reason: CommandResult["reason"] | undefined;
      let hardStop: ReturnType<typeof setTimeout> | undefined;
      let captured = 0;

      function signal(name: "SIGTERM" | "SIGKILL") {
        if (!alive || !processHandle) return;
        try {
          process.kill(-processHandle.pid, name);
        } catch {
          /* The process group may already have exited. */
        }
      }
      function stop(cause: CommandResult["reason"]) {
        if (settled || reason || (processHandle && !alive)) return;
        reason = cause;
        signal("SIGTERM");
        hardStop = setTimeout(() => {
          signal("SIGKILL");
        }, 1000);
      }
      const deadline = setTimeout(() => {
        stop("timeout");
      }, command.timeoutMs);
      function remaining(bytes: number) {
        const accepted = Math.min(bytes, command.maxOutputBytes - captured);
        captured += accepted;
        if (accepted < bytes) stop("output_limit");
        return accepted;
      }

      async function run(): Promise<CommandResult> {
        let out: FileHandle | undefined;
        let err: FileHandle | undefined;
        let exit: { exitCode: number | null; signal: string | null } = {
          exitCode: null,
          signal: null,
        };
        try {
          out = await open(join(directory, "stdout"), "wx", 0o600);
          err = await open(join(directory, "stderr"), "wx", 0o600);
          if (!reason) {
            const child = Bun.spawn(
              [
                "/usr/bin/unshare",
                "--fork",
                "--pid",
                "--mount-proc",
                "--kill-child=SIGKILL",
                "/usr/bin/tini",
                "--",
                "/usr/local/bin/bun",
                options.supervisorPath,
              ],
              {
                detached: true,
                cwd: "/app",
                env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
                stdin: new Blob([
                  JSON.stringify({
                    command: {
                      ...command,
                      cwd,
                      env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin", ...command.env },
                    },
                    receiptPath,
                  }),
                ]),
                stdout: "pipe",
                stderr: "pipe",
              },
            );
            processHandle = child;
            alive = true;
            const capture = (work: Promise<void>) =>
              work.then(
                () => true,
                () => {
                  stop("unknown");
                  return false;
                },
              );
            const output = [
              capture(stdout.capture(child.stdout, out, remaining)),
              capture(stderr.capture(child.stderr, err, remaining)),
            ];
            await child.exited;
            alive = false;
            clearTimeout(deadline);
            clearTimeout(hardStop);
            if ((await Promise.all(output)).includes(false)) reason = "unknown";
            try {
              if (lstatSync(receiptPath).size > 1024) throw new Error("Invalid exit receipt.");
              exit = commandExitSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
            } catch {
              reason ??= "unknown";
            }
          }
        } catch {
          reason ??= "unknown";
          signal("SIGKILL");
        } finally {
          settled = true;
          clearTimeout(deadline);
          clearTimeout(hardStop);
          try {
            await Promise.all([out?.sync(), err?.sync()]);
            syncDirectory(directory);
            syncDirectory(options.logsRoot);
          } finally {
            await Promise.all([out?.close(), err?.close()]);
          }
        }
        return {
          ...exit,
          reason: reason ?? "exited",
          durationMs: Math.round(performance.now() - started),
          stdout: stdout.finish(),
          stderr: stderr.finish(),
        };
      }

      const handle = {
        cancel: () => {
          stop("canceled");
        },
        result: run().finally(() => {
          active.delete(id);
        }),
      };
      active.set(id, handle);
      return handle;
    },
    async close() {
      closing = true;
      for (const handle of active.values()) handle.cancel();
      await Promise.all([...active.values()].map((handle) => handle.result));
    },
  };
}
