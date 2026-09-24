import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test(
  "native formatting rejects drift without rewriting and respects Git exclusions",
  { skip: process.platform !== "darwin" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "winston-swift-format-"));
    const script = fileURLToPath(new URL("./format-native.mjs", import.meta.url));
    const file = join(directory, "Sample File.swift");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      writeFileSync(join(directory, ".gitignore"), "ignored/\n");
      mkdirSync(join(directory, "ignored"));
      writeFileSync(join(directory, "ignored", "Generated.swift"), "not valid Swift\n");
      writeFileSync(join(directory, "Deleted.swift"), "let removed = 1\n");
      execFileSync("git", ["add", "Deleted.swift"], { cwd: directory });
      unlinkSync(join(directory, "Deleted.swift"));
      writeFileSync(file, "let value=1\n");
      const check = spawnSync(process.execPath, [script, "--check"], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.notEqual(check.status, 0);
      assert.equal(readFileSync(file, "utf8"), "let value=1\n");
      const format = spawnSync(process.execPath, [script, "--write"], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.equal(format.status, 0, format.stderr);
      assert.equal(readFileSync(file, "utf8"), "let value = 1\n");
      assert.equal(spawnSync(process.execPath, [script, "--check"], { cwd: directory }).status, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
