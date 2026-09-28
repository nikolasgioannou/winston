import type { ExecResult } from "@winston/domain/frames";

/** Each stream's output is capped; the rest is dropped and flagged. */
export const maxOutputBytes = 1024 * 1024;
/** How long a finished command's result is kept for `exec.fetch` (docs/design.md §15). */
export const resultRetentionMs = 5 * 60_000;
/** Output is streamed in chunks of at most this many characters. */
const chunkChars = 16 * 1024;

/**
 * How commands run as `winston`: a sudo rule that lets `winstond` run
 * anything as `winston` and nothing else (the least privilege it needs; see
 * docs/design.md §15). `env -i` starts from a clean environment, so nothing
 * of winstond's leaks. Tests run commands directly.
 */
export const asWinston = ["sudo", "-n", "-u", "winston", "--"];

const baseEnv = {
  HOME: "/home/winston",
  USER: "winston",
  LOGNAME: "winston",
  SHELL: "/bin/bash",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
};

export interface ExecRequest {
  id: string;
  cmd: string;
  cwd?: string | undefined;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface ExecEvents {
  output: (stream: "stdout" | "stderr", data: string) => void;
  exit: (result: {
    exitCode: number;
    timedOut: boolean;
    truncated: boolean;
  }) => void;
}

/**
 * Runs commands, streams their output, and keeps each result for five
 * minutes, so a gateway that lost the connection mid-command can fetch it
 * instead of running it again.
 */
export function createExecutor(
  options: { prefix?: string[]; defaultCwd?: string } = {},
) {
  const prefix = options.prefix ?? asWinston;
  const defaultCwd = options.defaultCwd ?? "/home/winston";
  const results = new Map<
    string,
    ExecResult & { done: boolean; waiters: ((r: ExecResult) => void)[] }
  >();

  function run(request: ExecRequest, events: ExecEvents) {
    const record = {
      stdout: "",
      stderr: "",
      exitCode: null as number | null,
      timedOut: false,
      truncated: false,
      done: false,
      waiters: [] as ((r: ExecResult) => void)[],
    };
    results.set(request.id, record);
    const seconds = (request.timeoutMs / 1000).toFixed(3);
    const env = Object.entries({ ...baseEnv, ...request.env }).map(
      ([key, value]) => `${key}=${value}`,
    );
    const started = performance.now();
    const proc = Bun.spawn(
      [
        ...prefix,
        "env",
        "-i",
        "-C",
        request.cwd ?? defaultCwd,
        ...env,
        // Signals the whole process group on timeout, so children die too.
        "timeout",
        "--kill-after=5",
        seconds,
        "bash",
        "-lc",
        request.cmd,
      ],
      { cwd: "/", stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );

    const pump = async (
      stream: ReadableStream<Uint8Array>,
      name: "stdout" | "stderr",
    ) => {
      const decoder = new TextDecoder();
      let bytes = 0;
      for await (const chunk of stream) {
        if (bytes >= maxOutputBytes) {
          record.truncated = true;
          continue;
        }
        const kept = chunk.subarray(0, maxOutputBytes - bytes);
        if (kept.length < chunk.length) record.truncated = true;
        bytes += kept.length;
        const text = decoder.decode(kept, { stream: true });
        record[name] += text;
        for (let i = 0; i < text.length; i += chunkChars)
          events.output(name, text.slice(i, i + chunkChars));
      }
      const rest = decoder.decode();
      if (rest) {
        record[name] += rest;
        events.output(name, rest);
      }
    };

    void Promise.all([
      pump(proc.stdout, "stdout"),
      pump(proc.stderr, "stderr"),
      proc.exited,
    ]).then(([, , exitCode]) => {
      // coreutils timeout exits 124, or 137 if it had to SIGKILL.
      const elapsed = performance.now() - started;
      record.exitCode = exitCode;
      record.timedOut =
        exitCode === 124 || (exitCode === 137 && elapsed >= request.timeoutMs);
      record.done = true;
      const result = {
        exitCode,
        timedOut: record.timedOut,
        truncated: record.truncated,
      };
      events.exit(result);
      for (const waiter of record.waiters.splice(0)) waiter(snapshot(record));
      setTimeout(() => results.delete(request.id), resultRetentionMs).unref();
    });
  }

  const snapshot = (record: ExecResult): ExecResult => ({
    stdout: record.stdout,
    stderr: record.stderr,
    exitCode: record.exitCode,
    timedOut: record.timedOut,
    truncated: record.truncated,
  });

  /** A command's result: now if finished, when it finishes if running, or undefined if unknown. */
  function fetch(id: string): Promise<ExecResult | undefined> {
    const record = results.get(id);
    if (!record) return Promise.resolve(undefined);
    if (record.done) return Promise.resolve(snapshot(record));
    return new Promise((resolve) => record.waiters.push(resolve));
  }

  return { run, fetch };
}

export type Executor = ReturnType<typeof createExecutor>;
