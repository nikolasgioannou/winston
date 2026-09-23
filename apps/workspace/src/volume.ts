import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

function directory(path: string, protectedDirectory: boolean) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid workspace directory.");
  if (protectedDirectory && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)) {
    throw new Error("Workspace control directories require exclusive write ownership.");
  }
  return stat;
}

export function openVolume(root: string, initialize: boolean) {
  const absolute = resolve(root);
  // Ancestor symlinks are resolved once. The configured mount itself must be a real directory.
  directory(absolute, true);
  const path = realpathSync(absolute);
  const control = join(path, "control");
  const home = join(path, "home");
  const filename = join(control, "operations.sqlite");

  if (initialize) {
    // Exclusive creation deliberately fails for existing or partially initialized volumes.
    // Recovery of a partial bootstrap is an operator decision, never a silent reset.
    mkdirSync(control, { mode: 0o700 });
    mkdirSync(home, { mode: 0o700 });
    closeSync(openSync(filename, "wx", 0o600));
  }

  const rootStat = directory(path, true);
  const controlStat = directory(control, true);
  const homeStat = directory(home, false);
  const fileStat = lstatSync(filename);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) {
    throw new Error("Invalid workspace journal file.");
  }
  if (fileStat.uid !== process.getuid?.() || (fileStat.mode & 0o077) !== 0) {
    throw new Error("Workspace journal must be private to its runtime.");
  }

  return {
    filename,
    home,
    assertPresent() {
      const current = [
        directory(path, true),
        directory(control, true),
        directory(home, false),
        lstatSync(filename),
      ];
      const expected = [rootStat, controlStat, homeStat, fileStat];
      for (const [index, stat] of current.entries()) {
        const original = expected[index];
        if (
          !original ||
          stat.isSymbolicLink() ||
          stat.ino !== original.ino ||
          stat.dev !== original.dev
        ) {
          throw new Error("Workspace storage was replaced or detached.");
        }
      }
    },
  };
}
