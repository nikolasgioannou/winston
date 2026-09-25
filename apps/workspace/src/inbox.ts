import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  artifactMetadataSchema,
  artifactSchema,
  maximumPublicationSize,
} from "@winston/contracts/artifacts";

function protectedDirectory(path: string, mode: number) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== mode
  )
    throw new Error("Unsafe inbox directory.");
  return stat;
}

function syncDirectory(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Called once while holding the volume lock, before accepting any transfer.
export function openWorkspaceInbox(root: string) {
  const base = resolve(root);
  const baseStat = lstatSync(base);
  if (
    !baseStat.isDirectory() ||
    baseStat.isSymbolicLink() ||
    baseStat.uid !== process.getuid?.() ||
    (baseStat.mode & 0o022) !== 0
  )
    throw new Error("Unsafe inbox volume.");
  protectedDirectory(join(base, "control"), 0o700);
  const inbox = join(base, "inbox");
  const temporary = join(base, "control", "inbox-pending");
  for (const [path, mode] of [
    [inbox, 0o755],
    [temporary, 0o700],
  ] as const) {
    try {
      mkdirSync(path, { mode });
      chmodSync(path, mode);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    protectedDirectory(path, mode);
  }
  const original = protectedDirectory(inbox, 0o755);
  const pending = protectedDirectory(temporary, 0o700);
  // No previous transfer survives the runtime's exclusive volume lock.
  for (const entry of readdirSync(temporary)) {
    if (!/^[0-9a-f-]{36}\.part$/.test(entry)) throw new Error("Unexpected inbox temporary file.");
    unlinkSync(join(temporary, entry));
  }
  syncDirectory(inbox);
  syncDirectory(temporary);
  syncDirectory(base);
  syncDirectory(join(base, "control"));

  function assertPresent() {
    for (const [path, mode, expected] of [
      [inbox, 0o755, original],
      [temporary, 0o700, pending],
    ] as const) {
      const current = protectedDirectory(path, mode);
      if (current.ino !== expected.ino || current.dev !== expected.dev)
        throw new Error("Inbox storage changed.");
    }
  }

  return {
    async publish(input: {
      id: string;
      size: number;
      sha256: string;
      bytes: Uint8Array;
      authorize: () => Promise<boolean>;
    }) {
      const id = artifactSchema.shape.id.parse(input.id);
      artifactMetadataSchema.shape.size.parse(input.size);
      artifactMetadataSchema.shape.sha256.parse(input.sha256);
      if (
        input.size > maximumPublicationSize ||
        input.bytes.byteLength !== input.size ||
        createHash("sha256").update(input.bytes).digest("hex") !== input.sha256
      )
        throw new Error("Invalid inbox bytes.");
      assertPresent();
      const destination = join(inbox, id);
      const partial = join(temporary, `${randomUUID()}.part`);
      const file = await open(partial, "wx", 0o600);
      try {
        await file.writeFile(input.bytes);
        await file.chmod(0o444);
        await file.sync();
        if (!(await input.authorize())) throw new Error("Inbox transfer no longer authorized.");
        assertPresent();
        try {
          // Publication has no await after authorization and never replaces an existing inode.
          linkSync(partial, destination);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          const stat = lstatSync(destination);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.uid !== process.getuid?.() ||
            (stat.mode & 0o777) !== 0o444 ||
            stat.size !== input.size
          )
            throw new Error("Inbox identity conflict.");
          const existing = await open(destination, "r");
          try {
            if (
              createHash("sha256")
                .update(await existing.readFile())
                .digest("hex") !== input.sha256
            )
              throw new Error("Inbox identity conflict.");
          } finally {
            await existing.close();
          }
          if (!(await input.authorize())) throw new Error("Inbox transfer no longer authorized.");
          assertPresent();
        }
        syncDirectory(inbox);
        return destination;
      } finally {
        await file.close();
        unlinkSync(partial);
        syncDirectory(temporary);
      }
    },
  };
}
