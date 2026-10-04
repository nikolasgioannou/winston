/**
 * File operations confined to the user's home (docs/design.md §15). They run
 * as `winston` (winstond re-invokes itself through sudo), so the OS enforces
 * permissions; this adds the confinement on top: no path, and no symlink,
 * may lead outside the root.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Telegram's bot upload limit, the largest file anything needs to move. */
export const maxFileBytes = 50 * 1024 * 1024;

export class FileOpError extends Error {
  constructor(
    readonly code:
      | "outside_home"
      | "not_found"
      | "not_a_file"
      | "too_large"
      | "mismatch"
      | "permission_denied",
    message: string,
  ) {
    super(message);
  }
}

const within = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);

/** Resolves `path` (relative to `root`, or absolute) and checks it stays inside `root`. */
function lexical(root: string, path: string) {
  const resolved = resolve(root, path);
  if (!within(root, resolved))
    throw new FileOpError("outside_home", `${path} is outside ${root}`);
  return resolved;
}

/** The real path of `path` after symlinks, checked to stay inside `root`. */
async function real(root: string, path: string) {
  const realRoot = await realpath(root);
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    // Following the link needed access winston doesn't have. Say where it
    // points if that's outside; otherwise it's a plain permission problem.
    const target = await readlink(path).catch(() => undefined);
    if (
      target !== undefined &&
      !within(realRoot, resolve(dirname(path), target))
    )
      throw new FileOpError("outside_home", `${path} leads outside ${root}`);
    throw new FileOpError("permission_denied", `${path} isn't accessible`);
  }
  if (!within(realRoot, resolved))
    throw new FileOpError("outside_home", `${path} leads outside ${root}`);
  return resolved;
}

/** A file inside `root`: its real path, after symlinks, and its size. */
export async function locateFile(root: string, path: string) {
  const target = lexical(root, path);
  let resolved: string;
  try {
    resolved = await real(root, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new FileOpError("not_found", `${path} doesn't exist`);
    throw error;
  }
  const info = await stat(resolved);
  if (!info.isFile())
    throw new FileOpError("not_a_file", `${path} isn't a file`);
  return { path: resolved, size: info.size };
}

/** Opens a file inside `root` for reading. */
export async function openForRead(root: string, path: string) {
  const found = await locateFile(root, path);
  if (found.size > maxFileBytes)
    throw new FileOpError("too_large", `${path} is over 50 MB`);
  return { size: found.size, stream: Bun.file(found.path).stream() };
}

/**
 * Writes a file inside `root` atomically: parent directories are created,
 * the bytes go to a temp file, and it's renamed over the target only if the
 * size and SHA-256 match what was promised. Otherwise nothing changes.
 */
export async function writeAtomically(
  root: string,
  path: string,
  expected: { size: number; sha256: string },
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
) {
  if (expected.size > maxFileBytes)
    throw new FileOpError("too_large", `${path} is over 50 MB`);
  const target = lexical(root, path);
  if (target === root)
    throw new FileOpError("not_a_file", `${path} isn't a file`);

  // The deepest existing ancestor must stay inside root once symlinks are followed.
  let ancestor = dirname(target);
  for (;;) {
    try {
      await real(root, ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  // An existing target that's a symlink must also stay inside.
  await real(root, target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });

  await mkdir(dirname(target), { recursive: true });
  const temp = join(
    dirname(target),
    `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const hash = createHash("sha256");
  let size = 0;
  const writer = Bun.file(temp).writer();
  try {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > expected.size)
        throw new FileOpError("mismatch", "more bytes than promised");
      hash.update(chunk);
      await writer.write(chunk);
    }
    await writer.end();
    const sha256 = hash.digest("hex");
    if (size !== expected.size || sha256 !== expected.sha256)
      throw new FileOpError(
        "mismatch",
        "the bytes don't match the promised size and hash",
      );
    await rename(temp, target);
    return { size, sha256 };
  } catch (error) {
    await Promise.resolve(writer.end()).catch(() => undefined);
    await rm(temp, { force: true });
    throw error;
  }
}
