import { fstatSync, readSync } from "node:fs";
import { cliAuthoritySchema } from "@winston/contracts/cli";

// The runtime supplies a read-only, anonymous regular file at fd 3. Never read stdin or a user path.
export function readAuthority(fd = 3) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size < 1 || stat.size > 4096)
    throw new Error("Invalid authority channel.");
  const buffer = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (!count) throw new Error("Incomplete authority channel.");
    offset += count;
  }
  return cliAuthoritySchema.parse(JSON.parse(buffer.toString("utf8")));
}
