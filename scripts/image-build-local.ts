/**
 * `bun run image:build:local`: compiles the winston CLI and winstond for
 * linux-arm64 (with their version embedded), then
 * builds the local Docker "VM" image (`winston-vm:local`) from
 * image/winston.pkr.hcl with it baked in. Packer's plugins install into
 * .packer/ in this checkout, not the global ~/.config/packer.
 */
const env = {
  ...process.env,
  PACKER_PLUGIN_PATH: `${process.cwd()}/.packer/plugins`,
};

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

// 0.1.<commits on main>+<short sha>, and .dirty for uncommitted changes.
const git = (...args: string[]) =>
  Bun.spawnSync(["git", ...args])
    .stdout.toString()
    .trim();
const dirty = git("status", "--porcelain") !== "";
const version = `0.1.${git("rev-list", "--count", "HEAD")}+${git("rev-parse", "--short", "HEAD")}${dirty ? ".dirty" : ""}`;
console.log(`Building winston and winstond ${version} for linux-arm64`);

for (const [app, binary] of [
  ["cli", "winston"],
  ["winstond", "winstond"],
] as const)
  await run([
    "bun",
    "build",
    "--compile",
    "--target=bun-linux-arm64",
    `--define=WINSTON_BUILD_VERSION=${JSON.stringify(version)}`,
    `apps/${app}/src/main.ts`,
    "--outfile",
    `image/build/${binary}-linux-arm64`,
  ]);
await run(["packer", "init", "image"]);
await run(["packer", "build", "-only=docker.local", "image"]);
