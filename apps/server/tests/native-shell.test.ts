import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

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
