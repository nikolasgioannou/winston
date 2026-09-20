import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitsForEvent } from "./check-commits.mjs";

test("commit ranges cover initial history, multiple commits, and fork PRs", () => {
  const directory = mkdtempSync(join(tmpdir(), "winston-history-"));

  function git(...args) {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
  }

  try {
    git("init", "--quiet");
    const tree = git("mktree");
    const first = git("commit-tree", tree, "-m", "chore: initial fixture");
    const second = git("commit-tree", tree, "-p", first, "-m", "feat: second fixture");
    const third = git("commit-tree", tree, "-p", second, "-m", "fix: third fixture");
    const fork = git("commit-tree", tree, "-p", first, "-m", "feat: fork fixture");
    const initial = { before: "0".repeat(40), after: third };

    assert.deepEqual(commitsForEvent(initial, directory), [first, second, third]);
    assert.deepEqual(commitsForEvent({ before: first, after: third }, directory), [second, third]);
    assert.deepEqual(
      commitsForEvent({ pull_request: { base: { sha: third }, head: { sha: fork } } }, directory),
      [fork],
    );
    assert.deepEqual(commitsForEvent({ before: "a".repeat(40), after: third }, directory), [
      first,
      second,
      third,
    ]);
    assert.throws(
      () => commitsForEvent({ after: "--all" }, directory),
      /Expected a full commit SHA/,
    );
    assert.throws(
      () =>
        commitsForEvent(
          { pull_request: { base: { sha: "a".repeat(40) }, head: { sha: fork } } },
          directory,
        ),
      /base is missing/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
