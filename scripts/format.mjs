import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];

if (mode !== "--check" && mode !== "--write") {
  throw new Error("Usage: node scripts/format.mjs --check|--write");
}

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((file) => file && existsSync(file));

const cli = fileURLToPath(import.meta.resolve("prettier/bin/prettier.cjs"));

// Keep argument lists bounded as the workspace grows.
for (let offset = 0; offset < files.length; offset += 100) {
  const result = spawnSync(
    process.execPath,
    [cli, mode, "--ignore-unknown", "--", ...files.slice(offset, offset + 100)],
    { stdio: "inherit" },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
