import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileOpError, openForRead, writeAtomically } from "./file-ops.ts";

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "winstond-files-")));
  const home = join(base, "home");
  await mkdir(home);
  await writeFile(join(base, "secret"), "outside");
  return { base, home };
}

function* chunks(data: Uint8Array, size: number) {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

const code = (error: unknown) =>
  error instanceof FileOpError ? error.code : String(error);

describe("file operations", () => {
  test("round trip, small and multi-chunk, keeps every byte", async () => {
    const { home } = await sandbox();
    for (const length of [5, 3 * 1024 * 1024 + 7]) {
      const data = new Uint8Array(length).map((_, i) => (i * 31) % 251);
      const written = await writeAtomically(
        home,
        "inbox/a.bin",
        { size: length, sha256: sha256(data) },
        chunks(data, 256 * 1024),
      );
      expect(written.sha256).toBe(sha256(data));
      const { size, stream } = await openForRead(home, "inbox/a.bin");
      expect(size).toBe(length);
      expect(
        sha256(new Uint8Array(await new Response(stream).arrayBuffer())),
      ).toBe(sha256(data));
    }
  });

  test("paths that escape the home are refused", async () => {
    const { home } = await sandbox();
    for (const path of ["../secret", "/etc/passwd", "inbox/../../secret"]) {
      expect(code(await openForRead(home, path).catch((e: unknown) => e))).toBe(
        "outside_home",
      );
      const data = new TextEncoder().encode("x");
      expect(
        code(
          await writeAtomically(
            home,
            path,
            { size: 1, sha256: sha256(data) },
            chunks(data, 1),
          ).catch((e: unknown) => e),
        ),
      ).toBe("outside_home");
    }
  });

  test("symlinks that lead outside are refused, for reads and writes", async () => {
    const { base, home } = await sandbox();
    await symlink(join(base, "secret"), join(home, "link-to-secret"));
    await symlink(base, join(home, "link-to-base"));
    expect(
      code(await openForRead(home, "link-to-secret").catch((e: unknown) => e)),
    ).toBe("outside_home");
    expect(
      code(
        await openForRead(home, "link-to-base/secret").catch((e: unknown) => e),
      ),
    ).toBe("outside_home");
    const data = new TextEncoder().encode("pwned");
    for (const path of ["link-to-secret", "link-to-base/new-file"]) {
      expect(
        code(
          await writeAtomically(
            home,
            path,
            { size: data.length, sha256: sha256(data) },
            chunks(data, 2),
          ).catch((e: unknown) => e),
        ),
      ).toBe("outside_home");
    }
    expect(await Bun.file(join(base, "secret")).text()).toBe("outside");
    expect(await Bun.file(join(base, "new-file")).exists()).toBe(false);
  });

  test("a failed write leaves no partial file and no temp file", async () => {
    const { home } = await sandbox();
    await writeFile(join(home, "notes.md"), "original");
    const data = new TextEncoder().encode("replacement text");
    const error = await writeAtomically(
      home,
      "notes.md",
      { size: data.length, sha256: "0".repeat(64) },
      chunks(data, 4),
    ).catch((e: unknown) => e);
    expect(code(error)).toBe("mismatch");
    expect(await Bun.file(join(home, "notes.md")).text()).toBe("original");
    expect(
      (await readdir(home)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("missing files, directories and oversized writes get clear errors", async () => {
    const { home } = await sandbox();
    expect(
      code(await openForRead(home, "nope.txt").catch((e: unknown) => e)),
    ).toBe("not_found");
    await mkdir(join(home, "dir"));
    expect(code(await openForRead(home, "dir").catch((e: unknown) => e))).toBe(
      "not_a_file",
    );
    const huge = await writeAtomically(
      home,
      "big",
      { size: 51 * 1024 * 1024, sha256: "0".repeat(64) },
      chunks(new Uint8Array(0), 1),
    ).catch((e: unknown) => e);
    expect(code(huge)).toBe("too_large");
  });
});
