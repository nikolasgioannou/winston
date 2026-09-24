import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("The native desktop app builds on macOS.");
} else {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const packagePath = join(root, "apps/desktop-macos");
  const options = { cwd: root, stdio: "inherit" };
  const buildArgs = ["swift", "build", "--package-path", packagePath, "-c", "release"];
  execFileSync("xcrun", [...buildArgs, "--product", "WinstonProxy"], options);
  const binPath = execFileSync("xcrun", [...buildArgs, "--show-bin-path"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const bundle = join(packagePath, "dist/Winston Development.app");
  mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
  copyFileSync(join(packagePath, "Info.plist"), join(bundle, "Contents/Info.plist"));
  copyFileSync(join(binPath, "WinstonProxy"), join(bundle, "Contents/MacOS/WinstonProxy"));
  execFileSync("codesign", ["--force", "--sign", "-", bundle], options);
  execFileSync("codesign", ["--verify", "--strict", bundle], options);
  console.log(`Built ${bundle}`);
}
