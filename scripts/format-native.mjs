import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Usage: node scripts/format-native.mjs --check|--write");
}

if (process.platform !== "darwin") {
  console.log("Native Swift formatting runs in the macOS quality gate.");
} else {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => file.endsWith(".swift") && existsSync(file));

  for (let offset = 0; offset < files.length; offset += 100) {
    const result = spawnSync(
      "xcrun",
      [
        "swift-format",
        ...(mode === "--check" ? ["lint", "--strict"] : ["format", "--in-place"]),
        "--",
        ...files.slice(offset, offset + 100),
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
