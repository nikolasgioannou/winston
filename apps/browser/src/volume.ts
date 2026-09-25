import { chownSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export function openBrowserVolume(root: string, initialize: boolean, profileUid: number) {
  const detectedUid = process.getuid?.();
  if (!Number.isSafeInteger(profileUid) || profileUid < 0)
    throw new Error("Invalid browser profile owner.");
  if (detectedUid === undefined) throw new Error("Browser storage requires Unix ownership.");
  const runtimeUid = detectedUid;

  function directory(path: string, uid: number, privateMode: boolean) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0
    )
      throw new Error("Browser directory ownership or permissions are unsafe.");
    return stat;
  }
  function file(path: string) {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== runtimeUid ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("Browser journal ownership or permissions are unsafe.");
    return stat;
  }

  const absolute = resolve(root);
  directory(absolute, runtimeUid, false);
  const path = realpathSync(absolute);
  const control = join(path, "control");
  const profile = join(path, "profile");
  const filename = join(control, "ownership.sqlite");
  if (initialize) {
    mkdirSync(control, { mode: 0o700 });
    mkdirSync(profile, { mode: 0o700 });
    if (profileUid !== runtimeUid) chownSync(profile, profileUid, profileUid);
    closeSync(openSync(filename, "wx", 0o600));
  }
  const expected = [
    directory(path, runtimeUid, false),
    directory(control, runtimeUid, true),
    directory(profile, profileUid, true),
    file(filename),
  ];

  function assertPresent() {
    const current = [
      directory(path, runtimeUid, false),
      directory(control, runtimeUid, true),
      directory(profile, profileUid, true),
      file(filename),
    ];
    for (const [index, stat] of current.entries()) {
      const original = expected[index];
      if (!original || original.ino !== stat.ino || original.dev !== stat.dev)
        throw new Error("Browser storage was replaced or detached.");
    }
    for (const suffix of ["-wal", "-shm", "-journal"])
      if (lstatSync(filename + suffix, { throwIfNoEntry: false })) file(filename + suffix);
  }
  assertPresent();
  return { filename, profile, assertPresent };
}
