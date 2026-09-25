import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

test.skipIf(process.platform !== "darwin")(
  "native upload snapshots preserve verified bytes and clean up across failures and cancellation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "winston-native-snapshots-"));
    const child = Bun.spawn(
      [
        "xcrun",
        "swift",
        "run",
        "--package-path",
        "apps/desktop-macos",
        "FileSnapshotsFixture",
        directory,
      ],
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
      assert.match(output, /Native file snapshot checks passed/);
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
