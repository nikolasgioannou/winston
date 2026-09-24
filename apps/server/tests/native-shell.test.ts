import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

test.skipIf(process.platform !== "darwin")(
  "native execution journal survives abrupt death and rejects replay, conflicts and unsafe storage",
  async () => {
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), "winston-journal-"));
    const binary = join(cwd, "apps/desktop-macos/.build/debug/JournalFixture");
    const run = async (command: string[]) => {
      const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
      try {
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assert.equal(code, 0, error);
        return output;
      } finally {
        child.kill();
      }
    };

    try {
      await run([
        "xcrun",
        "swift",
        "build",
        "--package-path",
        "apps/desktop-macos",
        "--product",
        "JournalFixture",
      ]);
      const exercise = join(directory, "exercise");
      await mkdir(exercise, { mode: 0o700 });
      assert.match(await run([binary, "exercise", exercise]), /Journal state checks passed/);

      const crash = join(directory, "crash");
      await mkdir(crash, { mode: 0o700 });
      const child = Bun.spawn([binary, "crash", crash], { cwd, stdout: "pipe", stderr: "pipe" });
      const errors = new Response(child.stderr).text();
      try {
        const reader = child.stdout.getReader();
        const first = await reader.read();
        assert.match(new TextDecoder().decode(first.value), /committed/);
        reader.releaseLock();
        assert.match(await run([binary, "locked", crash]), /Concurrent owner rejected/);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
      assert.equal(await errors, "");
      assert.match(await run([binary, "recover", crash]), /Crash recovery checks passed/);
      assert.match(await run([binary, "recover", crash]), /Crash recovery checks passed/);

      const corrupt = join(directory, "corrupt");
      await mkdir(corrupt, { mode: 0o700 });
      const database = join(corrupt, "executions.sqlite");
      await writeFile(database, "not a database", { mode: 0o600 });
      assert.match(await run([binary, "unavailable", corrupt]), /Unsafe storage rejected/);
      assert.equal(await readFile(database, "utf8"), "not a database");

      const unsafe = join(directory, "unsafe");
      await mkdir(unsafe, { mode: 0o700 });
      await symlink(database, join(unsafe, "executions.sqlite"));
      assert.match(await run([binary, "unavailable", unsafe]), /Unsafe storage rejected/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.platform !== "darwin")(
  "native shell keeps pause across reconnect and requires a fresh connection after wake",
  async () => {
    const child = Bun.spawn(
      ["xcrun", "swift", "run", "--package-path", "apps/desktop-macos", "ShellFixture"],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /Native shell lifecycle checks passed/);
    } finally {
      child.kill();
    }
  },
  60_000,
);

test.skipIf(process.platform !== "darwin")(
  "native session fences obsolete loops and handles pairing and Keychain failures",
  async () => {
    const child = Bun.spawn(
      ["xcrun", "swift", "run", "--package-path", "apps/desktop-macos", "SessionFixture"],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /Native session integration checks passed/);
    } finally {
      child.kill();
    }
  },
  60_000,
);
