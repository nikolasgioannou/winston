import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const installing = args[0] === "--install";
const command = installing ? ["install", "chromium", "--only-shell"] : ["test", ...args];

const result = spawnSync(
  process.execPath,
  [resolve(root, "node_modules/@playwright/test/cli.js"), ...command],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: resolve(root, "node_modules/.cache/ms-playwright"),
    },
  },
);

if (result.error) {
  console.error(result.error.message);
}

process.exitCode = result.status ?? 1;
