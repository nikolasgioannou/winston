import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { maximumPublicationSize } from "@winston/contracts/artifacts";

const stagingRoot = "/data/home/artifacts";

function contained(root: string, path: string) {
  const child = relative(root, path);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

// Runs as the unprivileged workspace user. No control-plane process opens model-supplied paths.
export async function snapshotPublishFile(input: string) {
  if (process.platform !== "linux")
    throw new Error("File inspection requires Winston's workspace.");
  if (!isAbsolute(input) || input.split("/").some((part) => part === ".." || part.startsWith(".")))
    throw new Error("Use an ordinary file in /data/home/artifacts.");
  const path = resolve(input);
  const root = await realpath(stagingRoot);
  if (root !== stagingRoot || !contained(root, path))
    throw new Error("Use an ordinary file in /data/home/artifacts.");
  let ancestor = root;
  for (const part of relative(root, path).split(sep)) {
    ancestor = resolve(ancestor, part);
    if ((await lstat(ancestor)).isSymbolicLink())
      throw new Error("File links cannot be published.");
  }
  const expected = await lstat(path, { bigint: true });
  if (!expected.isFile() || expected.size > BigInt(maximumPublicationSize))
    throw new Error("Publish a regular file no larger than 50 MiB.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    const actualPath = await realpath(`/proc/self/fd/${String(file.fd)}`);
    if (
      !contained(root, actualPath) ||
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.size > BigInt(maximumPublicationSize)
    )
      throw new Error("The staged file changed before it could be read.");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(
        bytes,
        offset,
        Math.min(65_536, bytes.length - offset),
        offset,
      );
      if (!result.bytesRead) throw new Error("The staged file changed while it was being read.");
      offset += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("The staged file changed while it was being read.");
    return {
      bytes,
      metadata: {
        path,
        name: basename(path),
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  } finally {
    await file.close();
  }
}
