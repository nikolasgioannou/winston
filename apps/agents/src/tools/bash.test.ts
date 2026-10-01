import { describe, expect, test } from "bun:test";
import type { ExecResult } from "@winston/domain/frames";
import { verifyRunToken } from "@winston/domain/run-token";
import { createLogger } from "@winston/shared/logger";
import { GatewayError, type VmClient } from "../vm/gateway-client.ts";
import { bashTimeoutMs, bashTool, modelOutputChars } from "./bash.ts";

const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const secret = "run-token-secret-0123456789abcdef";

/** A VM client that answers with `result` (or throws `error`) and records calls. */
function fakeVm(answer: Partial<ExecResult> | GatewayError) {
  const execs: Parameters<VmClient["exec"]>[1][] = [];
  const files: { path: string; text: string }[] = [];
  const vm: VmClient = {
    fetchExec: () => Promise.resolve(undefined),
    exec: (_userId, request) => {
      execs.push(request);
      if (answer instanceof GatewayError) return Promise.reject(answer);
      return Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
        ...answer,
      });
    },
    readFile: () => Promise.resolve(new Uint8Array()),
    writeFile: (_userId, path, bytes) => {
      files.push({ path, text: new TextDecoder().decode(bytes) });
      return Promise.resolve();
    },
  };
  return { vm, execs, files };
}

async function runBash(
  answer: Partial<ExecResult> | GatewayError,
  kind: "front" | "background" = "front",
) {
  const fake = fakeVm(answer);
  const bash = bashTool({
    vm: fake.vm,
    logger,
    runTokenSecret: secret,
    run: { runId: "run_1", userId: "usr_1", kind },
  });
  const output = (await bash.execute(
    { command: "ls ~" },
    { toolCallId: "c1", messages: [], context: {} },
  )) as string;
  return { ...fake, output };
}

describe("bash", () => {
  test("passes a verifiable run token and the front's short timeout", async () => {
    const { execs, output } = await runBash({ stdout: "notes.md\n" });
    expect(execs[0]).toMatchObject({
      cmd: "ls ~",
      timeoutMs: bashTimeoutMs.front,
    });
    const token = verifyRunToken(secret, execs[0]?.env.WINSTON_RUN_TOKEN ?? "");
    expect(token).toMatchObject({
      runId: "run_1",
      userId: "usr_1",
      kind: "front",
    });
    expect(output).toBe("exit code 0\n--- stdout ---\nnotes.md");
  });

  test("background runs get a much longer timeout", async () => {
    const { execs } = await runBash({}, "background");
    expect(execs[0]?.timeoutMs).toBe(bashTimeoutMs.background);
    expect(bashTimeoutMs.background).toBeGreaterThan(bashTimeoutMs.front * 10);
  });

  test("non-zero exits and stderr are shown plainly", async () => {
    const { output } = await runBash({
      stderr: "ls: cannot access 'x'\n",
      exitCode: 2,
    });
    expect(output).toBe("exit code 2\n--- stderr ---\nls: cannot access 'x'");
  });

  test("a timeout says so and keeps the partial output", async () => {
    const { output } = await runBash({
      stdout: "halfway\n",
      exitCode: 124,
      timedOut: true,
    });
    expect(output).toContain("stopped after 10 seconds");
    expect(output).toContain("halfway");
  });

  test("long output is cut to a head and tail, and saved in full on the VM", async () => {
    const long = Array.from(
      { length: 3000 },
      (_, i) => `line ${String(i)}`,
    ).join("\n");
    const { output, files } = await runBash({ stdout: long });
    expect(output.length).toBeLessThan(modelOutputChars + 300);
    expect(output).toContain("line 0");
    expect(output).toContain("line 2999");
    expect(output).toContain("characters omitted");
    expect(output).toContain("saved to ~/.winston/outputs/run_1/c1.txt");
    expect(files[0]?.path).toBe(".winston/outputs/run_1/c1.txt");
    expect(files[0]?.text).toContain("line 1500");
  });

  test("an unreachable computer is explained, not thrown", async () => {
    const down = await runBash(
      new GatewayError("vm_unavailable", "not connected"),
    );
    expect(down.output).toContain("isn't reachable right now");
    const lost = await runBash(
      new GatewayError("vm_unreachable", "stopped responding"),
    );
    expect(lost.output).toContain("may or may not have completed");
  });
});
