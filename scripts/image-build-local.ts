/**
 * `bun run image:build:local`: compiles the winston CLI and winstond for
 * linux-arm64 (with their version embedded), then
 * builds the local Docker "VM" image (`winston-vm:local`) from
 * image/winston.pkr.hcl with it baked in. Packer's plugins install into
 * .packer/ in this checkout, not the global ~/.config/packer.
 */
import {
  buildVersion,
  compileVmBinaries,
  packerEnv,
  run,
} from "./vm-binaries.ts";

const version = buildVersion();
console.log(`Building winston and winstond ${version} for linux-arm64`);
await compileVmBinaries("arm64", version);
await run(["packer", "init", "image"], packerEnv);
await run(["packer", "build", "-only=docker.local", "image"], packerEnv);
