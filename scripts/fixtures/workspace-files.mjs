import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, symlink, open, rm } from "node:fs/promises";

const root = "/data/home/artifacts";
await mkdir(root, { recursive: true });
const file = `${root}/fixture.txt`;
const inspect = (path) => {
  const result = spawnSync("winston", ["files", "inspect", "--path", path, "--json"], {
    encoding: "utf8",
  });
  return { exitCode: result.status, result: JSON.parse(result.stdout) };
};
try {
  await writeFile(file, "fixture");
  assert.deepEqual(inspect(file), {
    exitCode: 0,
    result: {
      version: 1,
      status: "ok",
      data: {
        path: file,
        name: "fixture.txt",
        size: 7,
        sha256: createHash("sha256").update("fixture").digest("hex"),
      },
    },
  });
  await writeFile(`${root}/empty.txt`, "");
  assert.equal(inspect(`${root}/empty.txt`).result.data.size, 0);
  await symlink(file, `${root}/link.txt`);
  await symlink("/data/control", `${root}/outside`);
  await writeFile(`${root}/.private`, "private");
  const large = await open(`${root}/large.bin`, "w");
  await large.truncate(50 * 1024 * 1024 + 1);
  await large.close();
  for (const path of [
    root,
    `${root}/link.txt`,
    `${root}/outside/operations.sqlite`,
    `${root}/.private`,
    `${root}/large.bin`,
    `${root}/../persistent.txt`,
    "/data/control/operations.sqlite",
    "/proc/self/environ",
  ]) {
    const rejected = inspect(path);
    assert.equal(rejected.exitCode, 6);
    assert.equal(rejected.result.status, "unavailable");
    assert.equal("data" in rejected.result, false);
  }
  console.log("Staged file inspection passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
