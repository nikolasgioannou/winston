import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Linux runs the TypeScript fixtures; the separate macOS CI job runs this same Swift gate.
if (process.platform !== "darwin") {
  console.log("Swift device protocol checks run on macOS.");
} else {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = spawnSync(
    "xcrun",
    [
      "swift",
      "run",
      "--package-path",
      "packages/device-protocol",
      "ProtocolFixtures",
      "packages/device-protocol/fixtures/messages.json",
    ],
    { cwd: root, stdio: "inherit" },
  );

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
}
