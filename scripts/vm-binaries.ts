/**
 * Shared by the image builds: the VM binaries' version and compiling them
 * (docs/design.md §18).
 */

/** Runs a command with output shown, exiting if it fails. */
export async function run(cmd: string[], env = process.env) {
  const proc = Bun.spawn(cmd, {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

const git = (...args: string[]) =>
  Bun.spawnSync(["git", ...args])
    .stdout.toString()
    .trim();

/** 0.1.<commits on main>+<short sha>, and .dirty for uncommitted changes. */
export function buildVersion() {
  const dirty = git("status", "--porcelain") !== "";
  return `0.1.${git("rev-list", "--count", "HEAD")}+${git("rev-parse", "--short", "HEAD")}${dirty ? ".dirty" : ""}`;
}

/** Compiles the winston CLI and winstond into image/build/<name>-linux-<arch>. */
export async function compileVmBinaries(
  arch: "arm64" | "x64",
  version: string,
) {
  for (const [app, binary] of [
    ["cli", "winston"],
    ["winstond", "winstond"],
  ] as const)
    await run([
      "bun",
      "build",
      "--compile",
      `--target=bun-linux-${arch}`,
      `--define=WINSTON_BUILD_VERSION=${JSON.stringify(version)}`,
      `apps/${app}/src/main.ts`,
      "--outfile",
      `image/build/${binary}-linux-${arch}`,
    ]);
}

/** Packer's plugins install into .packer/ in this checkout, not ~/.config. */
export const packerEnv = {
  ...process.env,
  PACKER_PLUGIN_PATH: `${process.cwd()}/.packer/plugins`,
};
