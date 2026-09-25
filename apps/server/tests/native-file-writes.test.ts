import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

test.skipIf(process.platform !== "darwin")(
  "native file writes verify bytes before publication and preserve destinations on failure or collision",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "winston-native-file-writes-"));
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
    const run = async (command: string[], expectedCode = 0) => {
      const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
      const timeout = setTimeout(() => {
        child.kill();
      }, 45_000);

      try {
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assert.equal(code, expectedCode, error);
        return output;
      } finally {
        clearTimeout(timeout);
        child.kill();
        await child.exited;
      }
    };

    try {
      const exercise = join(directory, "exercise");
      await mkdir(exercise);
      const output = await run([
        "xcrun",
        "swift",
        "run",
        "--package-path",
        "apps/desktop-macos",
        "FileWritesFixture",
        exercise,
      ]);
      assert.match(output, /Native verified file write checks passed/);

      const lost = join(directory, "lost");
      await mkdir(lost);
      const binary = join(cwd, "apps/desktop-macos/.build/debug/FileWritesFixture");
      assert.equal(await run([binary, lost, "lost-receipt"], 23), "");
      assert.equal(await readFile(join(lost, "result.txt"), "utf8"), "verified file contents");
      assert.match(
        await run([binary, lost, "retry"]),
        /Lost receipt did not permit duplicate publication/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
