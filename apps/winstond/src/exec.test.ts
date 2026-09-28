import { describe, expect, test } from "bun:test";
import { createExecutor, maxOutputBytes, type ExecRequest } from "./exec.ts";

// The command line uses GNU `env -C` and coreutils `timeout`, as on the VM:
// these run on Linux (CI, or a Linux container locally), not macOS.
const linux = process.platform === "linux";

/** Runs a command directly (no sudo) and collects everything it emits. */
function run(request: Partial<ExecRequest> & { cmd: string }) {
  const executor = createExecutor({ prefix: [], defaultCwd: "/tmp" });
  const output: { stream: string; data: string }[] = [];
  const done = new Promise<{
    exitCode: number;
    timedOut: boolean;
    truncated: boolean;
  }>((resolve) => {
    executor.run(
      { id: request.id ?? "e1", env: {}, timeoutMs: 10_000, ...request },
      {
        output: (stream, data) => output.push({ stream, data }),
        exit: resolve,
      },
    );
  });
  return { executor, output, done };
}

const joined = (output: { stream: string; data: string }[], stream: string) =>
  output
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.data)
    .join("");

describe.skipIf(!linux)("executor", () => {
  test("streams stdout and stderr separately, in order, and reports the exit code", async () => {
    const { output, done } = run({
      cmd: "echo one; echo oops >&2; echo two; exit 3",
    });
    expect(await done).toEqual({
      exitCode: 3,
      timedOut: false,
      truncated: false,
    });
    expect(joined(output, "stdout")).toBe("one\ntwo\n");
    expect(joined(output, "stderr")).toBe("oops\n");
  });

  test("runs in the given directory with only the given environment", async () => {
    process.env.WINSTOND_SECRET_TEST = "should-not-leak";
    const { output, done } = run({
      cmd: "pwd; printenv WINSTON_RUN_TOKEN; printenv WINSTOND_SECRET_TEST || echo absent",
      cwd: "/usr",
      env: { WINSTON_RUN_TOKEN: "run-123" },
    });
    await done;
    expect(joined(output, "stdout")).toBe("/usr\nrun-123\nabsent\n");
  });

  test("a timeout kills the whole process group, children included", async () => {
    const marker = `/tmp/winstond-child-${String(Date.now())}`;
    const { done } = run({
      cmd: `(sleep 3; touch ${marker}) & sleep 30`,
      timeoutMs: 500,
    });
    const result = await done;
    expect(result.timedOut).toBe(true);
    await Bun.sleep(3_500);
    expect(await Bun.file(marker).exists()).toBe(false);
  }, 15_000);

  test("output past the cap is dropped and flagged", async () => {
    const { executor, done } = run({
      cmd: `head -c ${String(maxOutputBytes + 1000)} /dev/zero | tr '\\0' 'a'`,
    });
    expect((await done).truncated).toBe(true);
    const result = await executor.fetch("e1");
    expect(result?.stdout.length).toBe(maxOutputBytes);
  });

  test("a result can be fetched after the fact, or awaited while running; unknown ids aren't found", async () => {
    const { executor, done } = run({
      id: "e2",
      cmd: "sleep 0.3; echo finished",
    });
    const early = executor.fetch("e2");
    await done;
    expect(await early).toMatchObject({ stdout: "finished\n", exitCode: 0 });
    expect(await executor.fetch("e2")).toMatchObject({ stdout: "finished\n" });
    expect(await executor.fetch("nope")).toBeUndefined();
  });
});
