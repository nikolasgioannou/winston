import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const commitlint = join(root, "node_modules/@commitlint/cli/cli.js");

test("commit messages follow Conventional Commits", () => {
  const messages = [
    ["chore(hooks): enforce checks\n", true],
    ["fix: handle missing configuration\n\nExplain the behavior change.\n", true],
    ["random message\n", false],
    ["unknown: enforce checks\n", false],
    ["fix: \n", false],
    ["fixup! chore(hooks): enforce checks\n", false],
  ];

  for (const [message, valid] of messages) {
    const result = spawnSync(process.execPath, [commitlint], {
      cwd: root,
      input: message,
      encoding: "utf8",
    });

    assert.equal(result.status, valid ? 0 : 1, result.stdout + result.stderr);
  }
});

test("staged checks reject partial and untracked edits without modifying them", () => {
  const directory = mkdtempSync(join(tmpdir(), "winston-staged-"));
  const file = join(directory, "sample.txt");

  function check() {
    return spawnSync(process.execPath, [join(root, "scripts/check-staged.mjs")], {
      cwd: directory,
      encoding: "utf8",
    });
  }

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    writeFileSync(file, "staged\n");
    execFileSync("git", ["add", "sample.txt"], { cwd: directory });

    assert.equal(check().status, 0);

    writeFileSync(file, "unstaged\n");
    const index = execFileSync("git", ["write-tree"], { cwd: directory });
    const rejected = check();

    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Stage the intended changes/);
    assert.equal(readFileSync(file, "utf8"), "unstaged\n");
    assert.deepEqual(execFileSync("git", ["write-tree"], { cwd: directory }), index);

    writeFileSync(file, "staged\n");
    writeFileSync(join(directory, "scratch.txt"), "untracked\n");

    assert.equal(check().status, 1);

    writeFileSync(join(directory, ".git/info/exclude"), "/scratch.txt\n");

    assert.equal(check().status, 0);
    assert.equal(readFileSync(join(directory, "scratch.txt"), "utf8"), "untracked\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("formatting respects Git exclusions, spaces, and unstaged deletions", () => {
  const directory = mkdtempSync(join(tmpdir(), "winston-format-"));
  const file = join(directory, "source file.js");
  const command = [join(root, "scripts/format.mjs")];

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    writeFileSync(join(directory, ".git/info/exclude"), "/private.md\n");
    writeFileSync(join(directory, "private.md"), "#   private\n");
    writeFileSync(file, "export const value=1;\n");
    writeFileSync(join(directory, "deleted.js"), "export {};\n");
    execFileSync("git", ["add", "deleted.js"], { cwd: directory });
    rmSync(join(directory, "deleted.js"));

    const failed = spawnSync(process.execPath, [...command, "--check"], {
      cwd: directory,
      encoding: "utf8",
    });

    assert.equal(failed.status, 1, failed.stderr);

    const fixed = spawnSync(process.execPath, [...command, "--write"], {
      cwd: directory,
      encoding: "utf8",
    });

    assert.equal(fixed.status, 0, fixed.stderr);
    assert.equal(readFileSync(file, "utf8"), "export const value = 1;\n");
    assert.equal(readFileSync(join(directory, "private.md"), "utf8"), "#   private\n");

    const passed = spawnSync(process.execPath, [...command, "--check"], {
      cwd: directory,
      encoding: "utf8",
    });

    assert.equal(passed.status, 0, passed.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
