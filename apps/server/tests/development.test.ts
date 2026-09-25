import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "bun:test";
import { runDevelopmentCommand } from "../src/development/runner";
import { checkDevelopmentPort } from "../src/development/ports";

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Development process condition timed out");
    await sleep(20);
  }
}

function exists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    return false;
  }
}

test("development runner stops siblings and owned descendants on failure or interrupt", async () => {
  for (const mode of ["failure", "abort", "stubborn"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "winston-dev-stack-"));
    const controller = new AbortController();
    const unrelated = Bun.spawn(
      [process.execPath, "--no-env-file", "-e", "setInterval(() => {}, 1000)"],
      { stdout: "ignore", stderr: "ignore" },
    );
    const pids: number[] = [];
    let result: Promise<number> | undefined;
    try {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ scripts: { first: "bun first.ts", second: "bun second.ts" } }),
      );
      const worker = `
        await Bun.write(process.argv[2], String(process.pid));
        process.on("SIGTERM", () => { ${mode === "stubborn" ? "" : "process.exit(0);"} });
        setInterval(() => {}, 1000);
      `;
      await writeFile(join(directory, "worker.ts"), worker);
      await writeFile(
        join(directory, "first.ts"),
        `
        const child = Bun.spawn([process.execPath, "worker.ts", "descendant.pid"], { stdout: "ignore", stderr: "ignore" });
        await Bun.write("first.pid", String(process.pid));
        process.on("SIGTERM", () => { ${mode === "stubborn" ? "" : "process.exit(0);"} });
        setInterval(() => {}, 1000);
        await child.exited;
      `,
      );
      await writeFile(
        join(directory, "second.ts"),
        mode === "failure"
          ? `
        while (!(await Bun.file("descendant.pid").exists())) await Bun.sleep(10);
        await Bun.write("second.pid", String(process.pid));
        process.exit(7);
      `
          : worker.replace("process.argv[2]", '"second.pid"'),
      );
      result = runDevelopmentCommand(
        [process.execPath, "--no-env-file", "run", "--parallel", "first", "second"],
        {
          cwd: directory,
          env: { ...process.env, NODE_ENV: "test" },
          signal: controller.signal,
          graceMs: 200,
        },
      );
      await until(async () => {
        const values = await Promise.all(
          ["first.pid", "second.pid", "descendant.pid"].map((name) =>
            readFile(join(directory, name), "utf8").catch(() => ""),
          ),
        );
        if (values.some((value) => !value)) return false;
        pids.push(...values.map(Number));
        return true;
      });
      if (mode !== "failure") controller.abort();
      const code = await result;
      if (mode === "failure") assert.notEqual(code, 0);
      else assert.equal(code, 0);
      await until(() => Promise.resolve(pids.every((pid) => !exists(pid))));
      assert.equal(unrelated.exitCode, null);
    } finally {
      controller.abort();
      await result;
      unrelated.kill();
      await unrelated.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 20_000);

test("already-aborted development startup launches nothing", async () => {
  assert.equal(
    await runDevelopmentCommand(["does-not-exist"], {
      cwd: tmpdir(),
      env: {},
      signal: AbortSignal.abort(),
    }),
    0,
  );
});

test("development port checks leave existing services untouched", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(checkDevelopmentPort(address.port), /unavailable/);
    assert.equal(server.listening, true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  await checkDevelopmentPort(address.port);
});
