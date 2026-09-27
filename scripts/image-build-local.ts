/**
 * `bun run image:build:local`: builds the local Docker "VM" image
 * (`winston-vm:local`) from image/winston.pkr.hcl. Packer's plugins install
 * into .packer/ in this checkout, not the global ~/.config/packer.
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

await run(["packer", "init", "image"]);
await run(["packer", "build", "-only=docker.local", "image"]);
