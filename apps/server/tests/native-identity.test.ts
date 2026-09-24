import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

test.skipIf(process.platform !== "darwin")(
  "native stored identity rejects corrupt credentials without accessing Keychain",
  async () => {
    const child = Bun.spawn(
      ["xcrun", "swift", "run", "--package-path", "packages/device-transport", "IdentityFixture"],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /Native identity validation passed; Keychain untouched/);
    } finally {
      child.kill();
    }
  },
  60_000,
);
