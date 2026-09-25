import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

test.skipIf(process.platform !== "darwin")(
  "native file reads enforce directory grants and return receipts only for complete, unchanged bytes",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "winston-native-files-"));
    const child = Bun.spawn(
      ["xcrun", "swift", "run", "--package-path", "apps/desktop-macos", "FilesFixture", directory],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdout: "pipe", stderr: "pipe" },
    );
    const timeout = setTimeout(() => {
      child.kill();
    }, 45_000);

    try {
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, error);
      assert.match(output, /Native scoped file read checks passed/);
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
